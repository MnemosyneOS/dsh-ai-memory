// 登录器本地验收。
//
// 分两层，刻意都不依赖「子进程出网」：
//   ① lib 层（同进程）：直接调 startDeviceFlow / pollDeviceFlow /
//      writeProfileKey，覆盖 device flow 协议与三分支幂等写入；
//   ② bin 层（子进程）：只测不联网的分支（--help / --remove / 已配置）。
//
// 为什么不让子进程联网：DSH 沙箱下 spawn 出的子进程连 127.0.0.1 也会超时
// （实测父进程 fetch 200、子进程挂死）。这是本会话环境的限制，不是被测代码
// 的缺陷；真实部署里用户在自己终端跑 dsh-ai-memory-login 没有这层沙箱。
//
// 运行：node test/login.test.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startDeviceFlow, pollDeviceFlow, waitForDeviceGrant } from '../lib/device-flow.js';
import { writeProfileKey, readProfile, removeProfileEntry } from '../lib/profile.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const LOGIN = path.join(ROOT, 'bin', 'dsh-ai-memory-login.js');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-test-'));
const FILE = path.join(WORK, 'cordis.patch.yml');
let PASS = 0, FAIL = 0;
const ck = (n, ok, d = '') => {
  (ok ? PASS++ : FAIL++);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (ok || !d ? '' : '  <- ' + String(d).slice(0, 240)));
};

// ---------------- mock device-flow server ----------------
// 用「每把 code 被 poll 过几次」而不是全局计数：waitForDeviceGrant 自己会
// poll 若干次，全局计数会让断言「再 poll 一次 expired」时状态已经漂移。
const state = { codes: new Map() };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/api/device/start') {
      const dc = 'dc_' + Math.random().toString(36).slice(2);
      state.codes.set(dc, { polls: 0, status: 'pending', key: 'mn-' + 'x'.repeat(30), ns: 'u_deadbeefdeadbeef' });
      return send(200, {
        device_code: dc, user_code: 'ABCD2345',
        verify_url: 'http://mock/api/device/confirm?code=ABCD2345',
        interval: 1, expires_in: 600,
      });
    }
    if (req.url === '/api/device/poll') {
      const row = state.codes.get(json.device_code);
      if (!row) return send(200, { status: 'expired' });
      row.polls += 1;
      // 第 2 次 poll 起视为用户已在浏览器点过「授权」。**只单向推进**：
      // 一旦 consumed 就不能再退回 approved，否则「一次性」无从断言 ——
      // 真实服务端也是这样，approve 是用户动作，轮询次数不会撤销它。
      if (row.status === 'pending' && row.polls >= 2) row.status = 'approved';
      if (row.status === 'pending') return send(200, { status: 'pending' });
      if (row.status === 'approved') {
        row.status = 'consumed';
        return send(200, {
          status: 'ok', key: row.key,
          mcp_url: 'https://ai-memory.net/v1/mcp', namespace: row.ns,
        });
      }
      return send(200, { status: 'expired' });
    }
    send(404, { error: 'not_found' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port;

// ================= ① lib 层：device flow 协议 =================
{
  const flow = await startDeviceFlow(BASE, 'test');
  ck('start：返回 deviceCode/userCode/verifyUrl/interval/expiresIn',
     flow.deviceCode && flow.userCode === 'ABCD2345'
     && flow.verifyUrl.includes('code=ABCD2345') && flow.interval === 1
     && flow.expiresIn === 600, flow);

  const first = await pollDeviceFlow(BASE, flow.deviceCode);
  ck('poll：授权前返回 pending', first.status === 'pending', first);

  // 再手动 poll 一次（mock 此时视为已授权），让 waitForDeviceGrant 从
  // 「已授权」状态起跑，断言才落在「一次性」上而不是时序上。
  const granted = await pollDeviceFlow(BASE, flow.deviceCode);
  ck('poll：授权后返回 ok + key', granted.status === 'ok' && granted.key.startsWith('mn-'), granted);

  const again = await pollDeviceFlow(BASE, flow.deviceCode);
  ck('poll：一次性 —— 再 poll 返回 expired', again.status === 'expired',
     'got: ' + JSON.stringify(again));

  const unknown = await pollDeviceFlow(BASE, 'no-such-code');
  ck('poll：未知 device_code 返回 expired（不给枚举留 oracle）',
     unknown.status === 'expired', unknown);
}

// 单独一把 code 验证 waitForDeviceGrant 的轮询循环
{
  const flow = await startDeviceFlow(BASE, 'test-wait');
  const grant = await waitForDeviceGrant({ baseUrl: BASE, deviceCode: flow.deviceCode, interval: 1 });
  ck('wait：pending → ok，拿到 key/mcpUrl/namespace',
     grant.key.startsWith('mn-') && grant.mcpUrl === 'https://ai-memory.net/v1/mcp'
     && grant.namespace === 'u_deadbeefdeadbeef', grant);
}

// ================= ② lib 层：三分支幂等写入 =================
const FIXTURE = `# My patch layer
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      qwen:
        apiKeyEnv: QWEN_API_KEY
`;

// 分支 1：全新文件 → 追加
fs.writeFileSync(FILE, FIXTURE, 'utf8');
{
  const res = writeProfileKey(FILE, 'mn-' + 'a'.repeat(30));
  ck('分支1 全新文件：写入成功', res.changed === true && !res.already, res);
  const text = fs.readFileSync(FILE, 'utf8');
  ck('分支1 追加块形状正确（顶层 - insert: 不带 id）',
     /\n- insert:\n {4}- id: mcp-dsh-ai-memory\n/.test(text), text);
  ck('分支1 原有注释与条目一字未动',
     text.includes('# My patch layer') && text.includes('welcomeNoticeVersion: 2026-09-28.1'));
  ck('分支1 Authorization 写入真 key', /Authorization: Bearer mn-a{30}/.test(text));
  ck('分支1 备份已生成', fs.existsSync(FILE + '.bak-dsh-ai-memory'));

  // 分支 2：再写一次 → 幂等
  const before = fs.readFileSync(FILE, 'utf8');
  const res2 = writeProfileKey(FILE, 'mn-' + 'b'.repeat(30));
  ck('分支2 已配置：不重复追加', res2.already === true && res2.changed === false, res2);
  ck('分支2 已配置：文件未被改动', fs.readFileSync(FILE, 'utf8') === before);
}

// 分支 3：有条目但 key 是占位符 → 只换那一行
fs.writeFileSync(FILE, `# keep this comment\n- insert:\n    - id: mcp-dsh-ai-memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: mnemosyne\n        transport: streamable-http\n        url: https://ai-memory.net/v1/mcp\n        headers:\n          Authorization: Bearer __MNEMOSYNE_KEY__\n`, 'utf8');
{
  const res = writeProfileKey(FILE, 'mn-' + 'c'.repeat(30));
  ck('分支3 占位符 key：替换成功', res.changed === true, res);
  const text = fs.readFileSync(FILE, 'utf8');
  ck('分支3 Authorization 已换成真 key', /Bearer mn-c{30}/.test(text) && !text.includes('__MNEMOSYNE_KEY__'));
  ck('分支3 条目数不变、注释保留',
     (text.match(/- insert:/g) || []).length === 1 && text.includes('# keep this comment'), text);
}

// 分支 4：历史 id（mcp-mnemosyne）→ 只换 key，不新增条目
fs.writeFileSync(FILE, `- insert:\n    - id: mcp-mnemosyne\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: mnemosyne\n        transport: streamable-http\n        url: https://ai-memory.net/v1/mcp\n        headers:\n          Authorization: Bearer __MNEMOSYNE_KEY__\n`, 'utf8');
{
  const res = writeProfileKey(FILE, 'mn-' + 'd'.repeat(30));
  ck('分支4 历史 id：替换成功', res.changed === true, res);
  const text = fs.readFileSync(FILE, 'utf8');
  ck('分支4 仍是单条目', (text.match(/- insert:/g) || []).length === 1, text);
  ck('分支4 读状态为已配置', readProfile(FILE).configured === true);

  const rem = removeProfileEntry(FILE);
  ck('remove：摘掉条目', rem.changed === true && !/serverName/.test(fs.readFileSync(FILE, 'utf8')),
     fs.readFileSync(FILE, 'utf8'));
}

// ================= ③ bin 层：不联网的分支 =================
function runCli(args) {
  const outF = path.join(WORK, 'cli-' + Math.random().toString(36).slice(2) + '.log');
  const errF = outF + '.err';
  const fd1 = fs.openSync(outF, 'w');
  const fd2 = fs.openSync(errF, 'w');
  const r = spawnSync(process.execPath, [LOGIN, ...args], { stdio: ['ignore', fd1, fd2], encoding: 'utf8' });
  fs.closeSync(fd1); fs.closeSync(fd2);
  return { status: r.status, stdout: fs.readFileSync(outF, 'utf8'), stderr: fs.readFileSync(errF, 'utf8') };
}
{
  const r = runCli(['--help']);
  ck('CLI --help：退出 0 且打印用法', r.status === 0 && /用法/.test(r.stdout), r.stdout + r.stderr);

  // 已配置 → 退出 0、不动文件（不联网，因为第一道判断就返回）
  fs.writeFileSync(FILE, `- insert:\n    - id: mcp-dsh-ai-memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: mnemosyne\n        transport: streamable-http\n        url: https://ai-memory.net/v1/mcp\n        headers:\n          Authorization: Bearer mn-e30e30e30e30e30e30e30e30e30\n`, 'utf8');
  const before = fs.readFileSync(FILE, 'utf8');
  const r2 = runCli(['--file', FILE, '--base-url', BASE]);
  ck('CLI 已配置：退出 0 并提示已配置（不发起授权）',
     r2.status === 0 && /已配置/.test(r2.stdout), r2.stdout + r2.stderr);
  ck('CLI 已配置：文件未被改动', fs.readFileSync(FILE, 'utf8') === before);

  const r3 = runCli(['--file', FILE, '--remove']);
  ck('CLI --remove：退出 0', r3.status === 0, r3.stdout + r3.stderr);
  ck('CLI --remove：条目已摘掉', !/serverName/.test(fs.readFileSync(FILE, 'utf8')));

  const r4 = runCli(['--file', path.join(WORK, 'no-such-file.yml')]);
  ck('CLI 文件不存在：明确报错且退出 1',
     r4.status === 1 && /找不到/.test(r4.stderr + r4.stdout), r4.stdout + r4.stderr);
}

server.close();
fs.rmSync(WORK, { recursive: true, force: true });
console.log('\n' + PASS + ' PASS / ' + FAIL + ' FAIL');
process.exit(FAIL ? 1 : 0);
