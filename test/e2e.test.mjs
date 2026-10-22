// 端到端验收：本地服务端 + 同进程登录器（不依赖子进程出网）
//
// 覆盖手册 §B5 的 B5-1 / B5-2，以及 §12 五步验收标准里
// 「装机 → 授权 → 配置正确」这三步；记忆召回需要线上网关，单独验。
//
// 为什么登录流程不走子进程：DSH 沙箱下 spawn 出的子进程连 127.0.0.1 也会
// 超时（实测父进程 fetch 200、子进程挂死）。这是本会话环境的限制，不是
// 被测代码的缺陷。CLI 外壳本身已在 login.test.mjs 里用子进程覆盖
// （--help / --remove / 已配置 / 文件不存在四个不联网分支）。
//
// 运行：node test/e2e.test.mjs
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { startDeviceFlow, pollDeviceFlow } from '../lib/device-flow.js';
import { writeProfileKey, readProfile } from '../lib/profile.js';

// 服务端仓库与本插件在工作区里的相对位置：
//   C:\AI_Workspace\06_Web\fly\server.py
//   C:\AI_Workspace\01_Agents\deepseek-harness\Mnemosyne OS\dsh-ai-memory\test\e2e.test.mjs
// test → dsh-ai-memory → Mnemosyne OS → deepseek-harness → 01_Agents → C:\AI_Workspace
const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const WORKSPACE = path.resolve(ROOT, '..', '..', '..', '..');
const SERVER = path.join(WORKSPACE, '06_Web', 'fly', 'server.py');
const LOGIN = path.join(ROOT, 'bin', 'dsh-ai-memory-login.js');

// python 解析：环境变量优先，其次常见安装位置，最后退回 PATH。
function findPython() {
  if (process.env.PYTHON_BIN && fs.existsSync(process.env.PYTHON_BIN)) return process.env.PYTHON_BIN;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cands = [
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
    'C:\\Python313\\python.exe', 'C:\\Python312\\python.exe',
  ];
  const hit = cands.find((p) => fs.existsSync(p));
  if (hit) return hit;
  const probe = spawnSync('python', ['-c', 'import sys'], { stdio: 'ignore' });
  return probe.status === 0 ? 'python' : null;
}
const PY = findPython();

let PASS = 0, FAIL = 0;
const ck = (n, ok, d = '') => {
  (ok ? PASS++ : FAIL++);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (ok || !d ? '' : '  <- ' + String(d).slice(0, 300)));
};

if (!PY || !fs.existsSync(SERVER)) {
  console.log('SKIP 找不到 python 或服务端 server.py（PY=' + PY + '）');
  console.log('端到端测试需要本地 python 与服务端仓库；跳过不影响单元验收。');
  process.exit(0);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-e2e-'));
const PROFILE_DIR = path.join(WORK, 'profiles', 'web');
const FILE = path.join(PROFILE_DIR, 'cordis.patch.yml');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 本地 mock 网关：验证「配好的 key 真的能握手」-------------------------
// 鉴权放行两类 Bearer：
//   ① 控制台→网关用的 GW_TOKEN（服务端 gateway_rpc 带的，来自 MNEMOSYNE_TOKEN）
//   ② 用户 key 本身（mn-…），用来验证 A3-4「这把 key 能过 /v1/mcp」
const gw = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const auth = req.headers['authorization'] || '';
    const ok = auth.startsWith('Bearer mn-') || auth === 'Bearer e2e-token';
    if (!ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 两条路径都要接：用户直调是 /v1/mcp，控制台→网关是 /mcp
    // （server.py 1199 行 gateway_rpc 拼的是 GATEWAY + '/mcp'）。
    if (req.url === '/v1/mcp' || req.url === '/mcp') {
      let msg = {};
      try { msg = JSON.parse(body); } catch {}
      if (msg.method === 'initialize') {
        return res.end(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: '2025-06-18', serverInfo: { name: 'mnemosyne', version: '8.1.0' } },
        }));
      }
      if (msg.method === 'tools/list') {
        return res.end(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { tools: [{ name: 'retain' }, { name: 'recall' }, { name: 'graph_query' }] },
        }));
      }
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'no route' } }));
  });
});
await new Promise((r) => gw.listen(0, '127.0.0.1', r));
const GW = 'http://127.0.0.1:' + gw.address().port;

// ---- 起本地控制台服务端 ---------------------------------------------------
// 端口由内核分配（bind 0 再立刻松开），不要自己拼 19000+随机：
// 撞上一个已被占用的端口时，服务端起不来，而断言会把「起不来」报成
// 「device flow 坏了」—— 那种偶发失败最难查。
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
const port = await freePort();
const env = {
  ...process.env,
  PORT: String(port), BIND: '127.0.0.1',
  MNEMOSYNE_CONSOLE_DATA: path.join(WORK, 'data'),
  MNEMOSYNE_DIR: WORK,
  PUBLIC_BASE_URL: 'http://127.0.0.1:' + port,
  MNEMOSYNE_GATEWAY: GW, MNEMOSYNE_ENGINE: GW,
  MNEMOSYNE_TOKEN: 'e2e-token',
  MN_ORIGIN_GUARD: 'off',
  PYTHONUNBUFFERED: '1',
  PYTHONIOENCODING: 'utf-8',
};
delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.http_proxy; delete env.https_proxy;

const srv = spawn(PY, ['-u', SERVER], {
  env, cwd: path.dirname(SERVER), stdio: ['ignore', 'pipe', 'pipe'],
});
const srvLog = [];
srv.stdout.on('data', (d) => srvLog.push(d.toString()));
srv.stderr.on('data', (d) => srvLog.push(d.toString()));

const BASE = 'http://127.0.0.1:' + port;
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(2000) });
    if (r.status === 200) { up = true; break; }
  } catch {}
  await sleep(300);
}
ck('本地服务端启动', up, srvLog.join('').slice(-300));

if (up) {
  // ① 注册账号（登录态由服务端会话 cookie 承担）
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'e2e@example.com', password: 'Passw0rd12', name: 'E2E' }),
  });
  const setCookie = reg.headers.get('set-cookie') || '';
  const m = /mn_sid=([A-Za-z0-9]+)/.exec(setCookie);
  ck('注册账号并拿到会话', (reg.status === 200 || reg.status === 201) && !!m, reg.status + ' ' + setCookie);
  const COOKIE = 'mn_sid=' + (m ? m[1] : '');

  // ② 用户 profile：一条自己的条目 + 注释（登录器必须一个字不动）
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const USER_FIXTURE = '# 用户自己的补丁层\n- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    apiKeyEnv: QWEN_API_KEY\n';
  fs.writeFileSync(FILE, USER_FIXTURE, 'utf8');

  // ③ B5-1：登录器打印的授权链接 —— 用 lib 层 start 拿到同一个 URL 形状
  const flow = await startDeviceFlow(BASE, 'dsh-ai-memory/1.0.0');
  ck('B5-1 start 返回 verify_url（登录器打印的就是它）',
     /\/api\/device\/confirm\?code=/.test(flow.verifyUrl), flow.verifyUrl);
  ck('verify_url 指向本地服务端（PUBLIC_BASE_URL 生效）',
     flow.verifyUrl.startsWith(BASE), flow.verifyUrl);

  // 落盘竞态：start 返回后 dash.json 未必已被读到最新内容，等它可见再往下走
  {
    const dashPath = path.join(WORK, 'data', 'dash.json');
    let seen = false;
    for (let i = 0; i < 50; i++) {
      try {
        const txt = fs.readFileSync(dashPath, 'utf8');
        if (txt.includes(flow.userCode)) { seen = true; break; }
      } catch {}
      await sleep(100);
    }
    ck('start 的条目已落盘可见（否则后续断言会撞观测竞态）', seen,
       'userCode=' + flow.userCode + ' path=' + dashPath);
  }

  // ④ 浏览器侧：带会话 approve（同进程 fetch，绕开子进程网络限制）
  const uc = flow.userCode;
  const ap = await fetch(BASE + '/api/device/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': COOKIE },
    body: JSON.stringify({ user_code: uc }),
  });
  const apBody = await ap.json().catch(() => ({}));
  ck('approve 成功并回显账号', ap.status === 200 && apBody.ok === true, ap.status + ' ' + JSON.stringify(apBody));

  // ⑤ 插件侧：poll 拿到 key（一次性）
  // 服务端在「已授权但状态没落盘」时会回 503+pending（安全侧拒发，防两把 key），
  // 客户端已把它归一成 pending。所以这里要轮询到真的拿到 key，不能假设一次成功。
  let first = { status: 'pending', key: '', mcpUrl: '', namespace: '' };
  for (let i = 0; i < 40; i++) {
    first = await pollDeviceFlow(BASE, flow.deviceCode);
    if (first.status === 'ok' && first.key) break;
    if (first.status === 'expired') break;
    await sleep(300);
  }
  ck('poll 第一次返回 ok + key + mcp_url + namespace',
     first.status === 'ok' && first.key.startsWith('mn-')
     && first.mcpUrl === BASE + '/v1/mcp' && /^u_[0-9a-f]{16}$/.test(first.namespace),
     JSON.stringify(first));
  const second = await pollDeviceFlow(BASE, flow.deviceCode);
  ck('poll 第二次返回 expired（一次性）', second.status === 'expired', JSON.stringify(second));

  // ⑥ B5-2：登录器的写盘逻辑（lib 层同一函数）
  const res = writeProfileKey(FILE, first.key);
  ck('B5-2 写入成功', res.changed === true && !res.already, JSON.stringify(res));
  const text = fs.readFileSync(FILE, 'utf8');
  ck('原有条目与注释一字未动',
     text.includes('# 用户自己的补丁层') && text.includes('apiKeyEnv: QWEN_API_KEY'));
  ck('追加块形状：顶层 - insert: 不带 id',
     /\n- insert:\n {4}- id: mcp-dsh-ai-memory\n/.test(text), text);
  ck('Authorization 是 poll 拿到的那把 key',
     text.includes('Authorization: Bearer ' + first.key));
  ck('备份已生成', fs.existsSync(FILE + '.bak-dsh-ai-memory'));
  ck('读状态为已配置', readProfile(FILE).configured === true);

  // ⑦ 用配好的 url + key 打一次 initialize：证明这条配置真的能用
  const init = await fetch(first.mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + first.key },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
    }),
  });
  ck('A3-4 用配好的 key 调 initialize 返回 200', init.status === 200, init.status);
  const initBody = await init.json().catch(() => ({}));
  ck('initialize 回 serverInfo', (initBody.result || {}).serverInfo !== undefined,
     JSON.stringify(initBody).slice(0, 200));

  const list = await fetch(first.mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + first.key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const listBody = await list.json().catch(() => ({}));
  ck('tools/list 能列出工具', ((listBody.result || {}).tools || []).length > 0,
     JSON.stringify(listBody).slice(0, 200));

  // ⑧ CLI 外壳：不联网的分支仍然用子进程验一遍（证明 bin 可独立执行）
  const outF = path.join(WORK, 'cli.log'), errF = outF + '.err';
  const fd1 = fs.openSync(outF, 'w'), fd2 = fs.openSync(errF, 'w');
  const cli = spawnSync(process.execPath, [LOGIN, '--help'], { stdio: ['ignore', fd1, fd2], encoding: 'utf8' });
  fs.closeSync(fd1); fs.closeSync(fd2);
  ck('CLI --help 退出 0', cli.status === 0 && /用法/.test(fs.readFileSync(outF, 'utf8')),
     cli.status + ' ' + fs.readFileSync(errF, 'utf8'));
}

srv.kill();
gw.close();
fs.rmSync(WORK, { recursive: true, force: true });
console.log('\n' + PASS + ' PASS / ' + FAIL + ' FAIL');
process.exit(FAIL ? 1 : 0);
