// dsh-ai-memory · Device Flow 客户端逻辑（零依赖）
//
// 只做协议，不碰文件系统、不碰进程：bin/ 里的 CLI 负责打印与写配置，
// 这个模块负责跟 ai-memory.net 的三个端点说话。
//
// 时序（实施手册 §1，认证方案 B）：
//   start  → {device_code, user_code, verify_url, interval, expires_in}
//   poll   → pending | ok(key, mcp_url, namespace) | expired | slow_down
//   approve  由浏览器在确认页里发，客户端不参与
//
// 三个硬约束在这里落地：
//   ① User-Agent 必须显式设成 `dsh-ai-memory/<version>` —— Cloudflare 会拦
//      Python-urllib 之类的默认 UA，返回 403（手册坑 #1）；
//   ② interval 由服务端给，客户端只在它基础上加码，不快于服务端；
//   ③ key 只在内存里出现一次：拿到后立刻交给调用方，这里不落日志、不落盘。

export const DEFAULT_BASE_URL = 'https://ai-memory.net';
export const USER_AGENT = 'dsh-ai-memory/1.0.0';

/** 抛给上层的错误带上 code，方便 CLI 区分「用户能自己修」与「服务端问题」。 */
export class DeviceFlowError extends Error {
  constructor(message, code = 'device_flow_error', status = 0) {
    super(message);
    this.name = 'DeviceFlowError';
    this.code = code;
    this.status = status;
  }
}

function joinUrl(base, path) {
  return String(base || DEFAULT_BASE_URL).replace(/\/+$/, '') + path;
}

async function postJson(url, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // 坑 #1：少了这一行，Cloudflare 直接 403，而 key 明明是好的。
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new DeviceFlowError('请求 ai-memory.net 超时，请检查网络后重试。', 'timeout');
    }
    throw new DeviceFlowError('连不上 ai-memory.net：' + (err && err.message ? err.message : err),
                              'network');
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 200) };
    }
  }
  if (!resp.ok) {
    const msg = (data && (data.message || data.error)) || ('HTTP ' + resp.status);
    throw new DeviceFlowError(String(msg), 'http_' + resp.status, resp.status);
  }
  return data;
}

/**
 * 发起一次设备授权。
 * @param {string} baseUrl 服务端根地址（测试可注入 mock server）
 * @param {string} client  调用方标识，仅用于服务端审计
 */
export async function startDeviceFlow(baseUrl, client = 'dsh-ai-memory') {
  const data = await postJson(joinUrl(baseUrl, '/api/device/start'), { client });
  if (!data.device_code || !data.user_code || !data.verify_url) {
    throw new DeviceFlowError('服务端返回缺少必要字段：' + JSON.stringify(data).slice(0, 200),
                              'bad_response');
  }
  return {
    deviceCode: String(data.device_code),
    userCode: String(data.user_code),
    verifyUrl: String(data.verify_url),
    interval: Math.max(1, Number(data.interval) || 5),
    expiresIn: Number(data.expires_in) || 600,
  };
}

/**
 * 轮询一次。
 *
 * 503 是「已授权但服务端状态没落盘」的**安全侧正确响应**：它拒绝再发一把
 * 密钥，让客户端稍后重试。所以这里不把它当错误，而是归一成 pending ——
 * 调用方（waitForDeviceGrant）会按普通 pending 继续等。
 *
 * @returns {Promise<{status: string, key?: string, mcpUrl?: string, namespace?: string}>}
 */
export async function pollDeviceFlow(baseUrl, deviceCode) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let resp;
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/device/poll'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // 坑 #1：少了这一行，Cloudflare 直接 403，而 key 明明是好的。
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ device_code: deviceCode }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new DeviceFlowError('请求 ai-memory.net 超时，请检查网络后重试。', 'timeout');
    }
    throw new DeviceFlowError('连不上 ai-memory.net：' + (err && err.message ? err.message : err),
                              'network');
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  }
  if (resp.status === 503 && data && data.status === 'pending') {
    // 安全侧拒发：归一成 pending，让上层继续等，不当成失败。
    return { status: 'pending', key: '', mcpUrl: '', namespace: '' };
  }
  if (!resp.ok) {
    const msg = (data && (data.message || data.error)) || ('HTTP ' + resp.status);
    throw new DeviceFlowError(String(msg), 'http_' + resp.status, resp.status);
  }
  return {
    status: String(data.status || ''),
    key: data.key ? String(data.key) : '',
    mcpUrl: data.mcp_url ? String(data.mcp_url) : '',
    namespace: data.namespace ? String(data.namespace) : '',
  };
}

/**
 * 轮询到出结果为止。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.deviceCode
 * @param {number} [opts.interval]   服务端给的基础间隔（秒）
 * @param {number} [opts.deadlineMs] 最长等待（毫秒），默认 10 分钟
 * @param {(info: {status: string, waitedMs: number}) => void} [opts.onPending]
 * @returns {Promise<{key: string, mcpUrl: string, namespace: string}>}
 */
export async function waitForDeviceGrant(opts) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const deviceCode = opts.deviceCode;
  let intervalSec = Math.max(1, Number(opts.interval) || 5);
  const deadline = Date.now() + (Number(opts.deadlineMs) || 600000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (;;) {
    const res = await pollDeviceFlow(baseUrl, deviceCode);
    if (res.status === 'ok') {
      if (!res.key) {
        throw new DeviceFlowError('服务端返回 status=ok 但没有密钥。', 'bad_response');
      }
      return { key: res.key, mcpUrl: res.mcpUrl, namespace: res.namespace };
    }
    if (res.status === 'expired') {
      throw new DeviceFlowError('授权请求已过期，请重新运行本命令。', 'expired');
    }
    // pending 与 slow_down 都继续等；slow_down 时把间隔放宽一倍再退避。
    if (res.status === 'slow_down') {
      intervalSec = Math.min(intervalSec * 2, 30);
    }
    if (opts.onPending) {
      opts.onPending({ status: res.status, waitedMs: (Number(opts.deadlineMs) || 600000) - (deadline - Date.now()) });
    }
    if (Date.now() + intervalSec * 1000 > deadline) {
      throw new DeviceFlowError('等待授权超时（10 分钟），请重新运行本命令。', 'timeout');
    }
    await sleep(intervalSec * 1000);
  }
}
