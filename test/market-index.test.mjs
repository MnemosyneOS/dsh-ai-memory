// 用官方校验器验证自建市场索引（手册 §8 E1/E2/E3）。
// 字段名不靠猜：parseMarketIndex / marketInstallTarget 是真校验器，
// 抛 MarketIndexError 就按 error.path 逐个补字段。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const idxPath = path.join(ROOT, 'market-index.json');

const candidates = [
  '@deepseek-ai/dsh-plugin-market-index',
];
let mod = null;
for (const c of candidates) {
  try { mod = require(c); break; } catch {}
}
if (!mod) {
  // 从 DSH 实现 checkout 里找
  const checkout = process.env.DSH_CHECKOUT
    || path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx', '1e7f6d9597241db0');
  const p = path.join(checkout, 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index');
  try { mod = require(p); } catch (e) {
    console.log('SKIP 找不到 @deepseek-ai/dsh-plugin-market-index：' + e.message);
    process.exit(0);
  }
}

const { parseMarketIndex, marketInstallTarget } = mod;
const raw = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
const SOURCE = 'https://ai-memory.net/market.json';

try {
  const idx = parseMarketIndex(raw, SOURCE);
  console.log('E1 PASS parseMarketIndex 未抛错');
  console.log('   plugins =', idx.plugins.length);
  const first = idx.plugins[0];
  console.log('   name =', first.name, '| versions =', (first.versions || []).length);

  // marketInstallTarget(name, version) 的第二个参数是**版本对象**
  // （Pick<MarketVersion,'version'|'source'>），不是版本字符串 —— 手册里写的
  // '1.0.0' 会直接 TypeError。从 parseMarketIndex 的返回值里取真版本对象。
  const ver = first.versions.find((v) => v.version === '1.0.0') || first.versions[0];
  const t = marketInstallTarget('dsh-ai-memory', ver);
  console.log('E2 marketInstallTarget ->', JSON.stringify(t));
  if (t && t.spec) {
    console.log('E2 PASS installTarget.spec =', t.spec);
    console.log('   可直接执行: dsh plugin add ' + t.spec);
  } else {
    console.log('E2 FAIL 没有拿到 spec');
  }

  const bytes = fs.statSync(idxPath).size;
  console.log('E3 索引文件大小 =', bytes, 'bytes（MAX_INLINE_ICON_BYTES 只约束 icon，不约束索引本身）');
} catch (e) {
  console.log('FAIL ' + e.name + ': ' + e.message);
  if (e.path) console.log('  error.path =', e.path);
  process.exit(1);
}
