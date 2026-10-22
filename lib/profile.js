// dsh-ai-memory · 用户 profile 的幂等写入（保注释、先备份、写完自检）
//
// 目标文件是用户 profile 的 cordis.patch.yml —— 一个顶层 YAML 数组，里面
// 通常还有几十行手写注释。手册 B4 的三条铁律在这里落地：
//   ① 只动 Authorization 那一行 / 只追加新块，其余一个字节不动
//      （禁用 yaml.safe_dump 整体重写，那会把注释洗掉 —— 手册坑 #11）；
//   ② 写之前先备份 <file>.bak-dsh-ai-memory；
//   ③ 写完自检（结构完整 + 一个 key），失败立刻从备份回滚。
//
// 只做「文本级」判断，不引第三方 YAML 解析器：这里要改的是注释旁边的一行，
// 引解析器反而要把它序列化回来，注释必丢。

import fs from 'node:fs';
import path from 'node:path';

export const ENTRY_ID = 'mcp-dsh-ai-memory';
export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client';
export const SERVER_NAME = 'mnemosyne';
export const MCP_URL = 'https://ai-memory.net/v1/mcp';
export const PLACEHOLDER = '__MNEMOSYNE_KEY__';

export class ProfileWriteError extends Error {
  constructor(message, code = 'profile_error') {
    super(message);
    this.name = 'ProfileWriteError';
    this.code = code;
  }
}

/** 登录器要追加/更新的那一块（形状见手册 B3：顶层 `- insert:` 不带 id）。 */
export function entryBlock(key) {
  return [
    '- insert:',
    '    - id: ' + ENTRY_ID,
    "      name: '" + MCP_PLUGIN_NAME + "'",
    '      config:',
    '        serverName: ' + SERVER_NAME,
    '        transport: streamable-http',
    '        url: ' + MCP_URL,
    '        headers:',
    '          Authorization: Bearer ' + key,
  ].join('\n');
}

/** 找出「属于 Mnemosyne 的 mcp-client 条目」的起始行（按 url 认，不按 id 认）。 */
function findMnemosyneEntryLines(text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^\\s*-\\s+id:\\s*' + ENTRY_ID + '\\s*$').test(lines[i])) hits.push(i);
  }
  // 历史遗留：手册早期用的 id 是 mcp-mnemosyne，profile 里可能已经是它
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^\\s*-\\s+id:\\s*mcp-mnemosyne\\s*$').test(lines[i]) && !hits.includes(i)) {
      hits.push(i);
    }
  }
  // 再兜一层：任何 serverName 为 mnemosyne 的条目（不管 id 叫什么）
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*serverName:\s*mnemosyne\s*$/.test(lines[i]) && !hits.includes(i)) hits.push(i);
  }
  return { lines, hits: hits.sort((a, b) => a - b) };
}

/** 条目是否已经持有真 key（不是占位符）。 */
function entryHasRealKey(lines, startIdx) {
  const end = Math.min(lines.length, startIdx + 14);
  for (let i = startIdx; i < end; i++) {
    const m = /^\s*Authorization:\s*Bearer\s+(\S+)\s*$/.exec(lines[i] || '');
    if (m) return m[1] !== PLACEHOLDER && /^mn-/.test(m[1]);
  }
  return false;
}

/**
 * 自检：结构上仍是一个顶层数组、Mnemosyne 条目存在、Authorization 只有一行真 key。
 * 刻意不做完整 YAML 解析 —— 保留注释的代价就是只做文本级校验。
 */
function selfCheck(text) {
  const problems = [];
  const body = stripComments(text).trim();
  if (body && !body.startsWith('-')) {
    problems.push('顶层不是 YAML 数组');
  }
  const { lines, hits } = findMnemosyneEntryLines(text);
  if (hits.length === 0) {
    problems.push('找不到 Mnemosyne 条目');
  }
  const authLines = lines.filter((l) => /^\s*Authorization:\s*Bearer\s+mn-\S+\s*$/.test(l));
  if (authLines.length !== 1) {
    problems.push('Authorization 真 key 行数 = ' + authLines.length + '（应为 1）');
  }
  if (hits.length === 1 && !entryHasRealKey(lines, hits[0])) {
    problems.push('条目里没有真 key');
  }
  return problems;
}

/** 去掉整行注释（自检用，避免把注释里的 `-` 当成数组项）。 */
function stripComments(text) {
  return text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
}

export function defaultProfilePath() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
}

/**
 * 读当前状态。
 * @returns {{exists: boolean, configured: boolean, text: string}}
 */
export function readProfile(file) {
  if (!fs.existsSync(file)) {
    return { exists: false, configured: false, text: '' };
  }
  const text = fs.readFileSync(file, 'utf8');
  const { lines, hits } = findMnemosyneEntryLines(text);
  const configured = hits.length > 0 && entryHasRealKey(lines, hits[0]);
  return { exists: true, configured, text };
}

/**
 * 幂等写入 key。
 *
 * - 已配置真 key          → 不动文件，返回 {changed: false, already: true}
 * - 有条目但 key 是占位符  → 只替换那一行 Authorization
 * - 没有任何 Mnemosyne 条目 → 追加一个 insert 块
 *
 * 备份与回滚都在这里做，调用方只管结果。
 */
export function writeProfileKey(file, key) {
  const state = readProfile(file);
  if (!state.exists) {
    throw new ProfileWriteError('找不到配置文件：' + file + '\n请先运行一次 dsh web 生成 profile。',
                                'missing_file');
  }
  if (state.configured) {
    return { changed: false, already: true, backup: null };
  }

  const original = state.text;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const { hits } = findMnemosyneEntryLines(original);
  let next;

  if (hits.length > 0) {
    // 只换 Authorization 行：其余字节（含 36+ 行注释）一律不动。
    next = lines.slice();
    const start = hits[0];
    let replaced = false;
    for (let i = start; i < Math.min(next.length, start + 14); i++) {
      if (/^\s*Authorization:\s*Bearer\s+\S+\s*$/.test(next[i])) {
        const indent = /^(\s*)/.exec(next[i])[1];
        next[i] = indent + 'Authorization: Bearer ' + key;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      // 条目里根本没有 headers 段（极少见）：在 url 行后补一个
      for (let i = start; i < Math.min(next.length, start + 14); i++) {
        if (/^\s*url:\s*\S+/.test(next[i])) {
          next.splice(i + 1, 0, '        headers:',
                      '          Authorization: Bearer ' + key);
          break;
        }
      }
    }
  } else {
    // 追加。保持与文件原有行尾一致；文件末尾没有换行时先补一个空行。
    const tail = original.length && !original.endsWith('\n') ? [eol] : [];
    next = lines.concat(tail, '- insert:', '    - id: ' + ENTRY_ID,
                        "      name: '" + MCP_PLUGIN_NAME + "'", '      config:',
                        '        serverName: ' + SERVER_NAME,
                        '        transport: streamable-http',
                        '        url: ' + MCP_URL, '        headers:',
                        '          Authorization: Bearer ' + key);
  }

  const written = next.join(eol);

  const problems = selfCheck(written);
  if (problems.length) {
    throw new ProfileWriteError('写入前自检未通过，未改动原文件：' + problems.join('；'),
                                'selfcheck');
  }

  const backup = file + '.bak-dsh-ai-memory';
  fs.writeFileSync(backup, original, 'utf8');
  try {
    fs.writeFileSync(file, written, 'utf8');
  } catch (err) {
    // 写失败：把备份还原回去，不留半截文件
    try {
      fs.copyFileSync(backup, file);
    } catch { /* 忽略：原文件本来没动 */ }
    throw new ProfileWriteError('写入失败并已回滚：' + err.message, 'write_failed');
  }
  return { changed: true, already: false, backup };
}

/** 卸掉本插件写入的条目（恢复备份或摘掉那块）。 */
export function removeProfileEntry(file) {
  const state = readProfile(file);
  if (!state.exists || !state.text) return { changed: false };
  const eol = state.text.includes('\r\n') ? '\r\n' : '\n';
  const { lines, hits } = findMnemosyneEntryLines(state.text);
  if (hits.length === 0) return { changed: false };
  // 从条目起始行往回吃掉紧邻的空行，往前吃到下一个顶层项之前
  let start = hits[0];
  while (start > 0 && lines[start - 1].trim() === '') start--;
  let end = start;
  while (end < lines.length && !/^- /.test(lines[end])) end++;
  // 如果块前还有 `- insert:` 行（我们自己的写法），一起摘
  let start2 = start;
  while (start2 > 0 && /^- insert:\s*$/.test(lines[start2 - 1])) start2--;
  const next = lines.slice(0, start2).concat(lines.slice(end));
  fs.writeFileSync(file, next.join(eol), 'utf8');
  return { changed: true };
}
