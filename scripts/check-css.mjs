/**
 * CSS 结构自检。
 *
 * 背景：曾因批量删除样式时误删花括号，导致 @media 块未闭合，
 * 使其后所有规则被包进媒体查询——窄屏正常、宽屏完全失效，
 * 且 tsc 与 vite 构建都不会报错，极难发现。
 *
 * 本脚本校验：花括号配平、无多余右括号、@media 块正确闭合。
 * 已挂到 build 之前，防止回归。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['src/App.css', 'src/index.css'];

function stripNoise(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, 'STR');
}

let failed = false;

for (const file of files) {
  const path = join(projectRoot, file);
  if (!existsSync(path)) continue;

  const raw = readFileSync(path, 'utf8');
  const css = stripNoise(raw);
  const lines = raw.split('\n').length;

  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;

  let depth = 0;
  let line = 1;
  let firstNegative = -1;
  for (const ch of css) {
    if (ch === '\n') line += 1;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth < 0 && firstNegative < 0) firstNegative = line;
    }
  }

  let ok = true;
  if (open !== close) {
    console.error('[FAIL] ' + file + ': 花括号不配平 { =' + open + ' } =' + close);
    ok = false;
  }
  if (firstNegative > 0) {
    console.error('[FAIL] ' + file + ': 第 ' + firstNegative + ' 行出现多余的 }');
    ok = false;
  }

  const mediaRe = /@media[^{]*\{/g;
  let m;
  while ((m = mediaRe.exec(css)) !== null) {
    const startLine = css.slice(0, m.index).split('\n').length;
    let d = 0;
    for (let i = m.index + m[0].length - 1; i < css.length; i += 1) {
      if (css[i] === '{') d += 1;
      if (css[i] === '}') {
        d -= 1;
        if (d === 0) break;
      }
    }
    if (d !== 0) {
      console.error('[FAIL] ' + file + ': 第 ' + startLine + ' 行的 @media 块未闭合');
      ok = false;
    }
  }

  if (ok) console.log('[ok] ' + file + ': ' + lines + ' 行，结构正常');
  else failed = true;
}

if (failed) {
  console.error('\nCSS 结构检查未通过');
  process.exit(1);
}
console.log('\nCSS 结构检查通过');