/**
 * 零依赖的 .env 解析器。
 *
 * 不引第三方包，避免为一个配置文件增加依赖。
 * 支持：KEY=value、# 注释、空行、引号包裹的值。
 * 已存在的 process.env 优先，不被文件覆盖。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/**
 * 加载项目根目录的 .env，返回解析出的键值对。
 * 文件不存在时返回空对象，不抛异常。
 */
export function loadEnvFile(fileName = '.env') {
  const path = join(projectRoot, fileName);
  if (!existsSync(path)) return {};

  const out = {};
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return {};
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

/**
 * 把 .env 中的值写入 process.env（已存在的键不覆盖）。
 */
export function applyEnvFile(fileName = '.env') {
  const parsed = loadEnvFile(fileName);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

export { projectRoot };
