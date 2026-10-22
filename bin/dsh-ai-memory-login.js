#!/usr/bin/env node
// dsh-ai-memory-login · DeepSeek Harness × Mnemosyne OS 首次授权
//
// 用法：
//   dsh-ai-memory-login                # 默认写 %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml
//   dsh-ai-memory-login --profile web  # 换 profile
//   dsh-ai-memory-login --file <path>  # 直接指定文件（测试用）
//   dsh-ai-memory-login --remove       # 卸掉本插件写入的条目
//   dsh-ai-memory-login --help
//
// 退出码：0 成功或已配置｜1 失败｜2 用户取消 / 超时
//
// 三条铁律（手册 B4）：只动 Authorization 行、写前备份、写完自检。
// key 全程只显前后 4 位（手册坑 #12）。

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  DEFAULT_BASE_URL, DeviceFlowError,
  startDeviceFlow, waitForDeviceGrant,
} from '../lib/device-flow.js';
import {
  defaultProfilePath, readProfile, writeProfileKey, removeProfileEntry,
  ENTRY_ID, MCP_URL,
} from '../lib/profile.js';

const argv = process.argv.slice(2);
const opt = (name, alt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : (alt !== undefined ? alt : null);
};
const has = (name) => argv.includes('--' + name);

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const c = (color, s) => (process.stdout.isTTY ? C[color] + s + C.reset : s);

const HELP = `dsh-ai-memory-login — 给 DeepSeek Harness 授权 Mnemosyne 记忆库

用法:
  dsh-ai-memory-login [选项]

选项:
  --profile <name>   目标 DSH profile（默认 web）
  --file <path>      直接指定 cordis.patch.yml 的路径
  --base-url <url>   服务端地址（默认 ${DEFAULT_BASE_URL}）
  --no-browser       不尝试自动打开浏览器
  --remove           卸掉本插件写入的 MCP 条目
  -h, --help         显示本帮助

流程:
  1. 打印授权链接（浏览器打开）
  2. 登录并点「授权」
  3. 本命令自动拿到密钥并写入 profile
  4. 重启 dsh web 生效
`;

if (has('h') || has('help')) {
  process.stdout.write(HELP);
  process.exit(0);
}

const profile = opt('profile', 'web');
const file = opt('file') || defaultProfilePath();
const baseUrl = opt('base-url', DEFAULT_BASE_URL) || DEFAULT_BASE_URL;
const noBrowser = has('no-browser');

function maskKey(key) {
  if (!key || key.length < 12) return '(密钥过短，已隐藏)';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

function openBrowser(url) {
  // 必须用 stdio: 'ignore'：沙箱里 pipe 会 EPERM（手册 §Windows 约束）。
  // 打不开不影响主流程，链接已经打印在终端里了。
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 忽略：静默降级为手工打开 */ }
}

if (has('remove')) {
  try {
    const r = removeProfileEntry(file);
    if (r.changed) {
      process.stdout.write(c('green', '✓ ') + '已从配置中移除 ' + ENTRY_ID + '\n');
      process.stdout.write('重启 dsh web 生效。\n');
      process.exit(0);
    }
    process.stdout.write('配置里没有本插件的条目，无需移除。\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(c('red', '✗ ') + '移除失败：' + err.message + '\n');
    process.exit(1);
  }
}

(async () => {
  let state;
  try {
    state = readProfile(file);
  } catch (err) {
    process.stderr.write(c('red', '✗ ') + '读不了 ' + file + '：' + err.message + '\n');
    process.exit(1);
  }
  if (!state.exists) {
    process.stderr.write(c('red', '✗ ') + '找不到 ' + file + '\n'
      + '请先运行一次 dsh web（它会生成 profile 目录），再回来执行本命令。\n');
    process.exit(1);
  }
  if (state.configured) {
    process.stdout.write(c('green', '✓ ') + 'dsh-ai-memory 已配置，无需重新授权。\n'
      + c('dim', '  (' + file + ')\n'));
    process.exit(0);
  }

  process.stdout.write('\n' + c('bold', 'DeepSeek Harness × Mnemosyne OS 首次授权') + '\n');
  process.stdout.write(c('dim', '目标配置：' + file + '\n\n'));

  let flow;
  try {
    flow = await startDeviceFlow(baseUrl, 'dsh-ai-memory/1.0.0');
  } catch (err) {
    if (err instanceof DeviceFlowError) {
      process.stderr.write(c('red', '✗ ') + '无法发起授权：' + err.message + '\n');
    } else {
      process.stderr.write(c('red', '✗ ') + '无法发起授权：' + err + '\n');
    }
    process.exit(1);
  }

  process.stdout.write(c('cyan', '请在浏览器打开下面这个地址完成授权：') + '\n\n');
  process.stdout.write('    ' + c('bold', flow.verifyUrl) + '\n\n');
  process.stdout.write(c('dim', '  授权码：' + flow.userCode + '（页面会自动带上，手工输入也行）\n'));
  process.stdout.write(c('dim', '  有效期 ' + Math.round(flow.expiresIn / 60) + ' 分钟；'
    + '授权后本命令会自动拿到密钥。\n\n'));

  if (!noBrowser) openBrowser(flow.verifyUrl);

  let grant;
  try {
    grant = await waitForDeviceGrant({
      baseUrl,
      deviceCode: flow.deviceCode,
      interval: flow.interval,
      deadlineMs: flow.expiresIn * 1000,
      onPending: (info) => {
        if (info.status === 'slow_down') return; // 已经自动放慢，不打扰
        if (info.waitedMs % 30000 < 6000) {
          process.stdout.write(c('dim', '  …等待浏览器里点「授权」\n'));
        }
      },
    });
  } catch (err) {
    const code = err && err.code;
    process.stderr.write(c('yellow', '! ') + (err && err.message ? err.message : err) + '\n');
    process.exit(code === 'expired' || code === 'timeout' ? 2 : 1);
  }

  let res;
  try {
    res = writeProfileKey(file, grant.key);
  } catch (err) {
    process.stderr.write(c('red', '✗ ') + '拿到密钥但写不进配置：' + err.message + '\n'
      + '  原文件未损坏（' + (err.backup || '未创建备份') + '）。\n');
    process.exit(1);
  }

  process.stdout.write('\n' + c('green', '✓ 授权完成') + '\n');
  process.stdout.write('  密钥      ' + c('dim', maskKey(grant.key)) + '\n');
  process.stdout.write('  命名空间  ' + c('dim', grant.namespace || '(默认)') + '\n');
  process.stdout.write('  MCP 地址  ' + c('dim', grant.mcpUrl || MCP_URL) + '\n');
  if (res.already) {
    process.stdout.write(c('dim', '  （配置里已是同一个账号，未改动文件）\n'));
  } else {
    process.stdout.write('  已写入    ' + c('dim', file) + '\n');
    process.stdout.write(c('dim', '  备份     ' + (res.backup || '(无)') + '\n'));
  }
  process.stdout.write('\n' + c('bold', '下一步：重启 dsh web，然后在会话里说"记住：我叫张三，乳糖不耐"。\n\n'));
  process.exit(0);
})().catch((err) => {
  process.stderr.write(c('red', '✗ ') + '意外失败：' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
