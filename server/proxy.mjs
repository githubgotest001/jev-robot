/**
 * Jev 决策代理服务（推荐启用）。
 *
 * 作用：把 Jev 的 API Key 留在服务端，前端只与本服务通信，
 * 避免密钥出现在浏览器中。本服务是**透传转发**，不做任何改写：
 * 请求体原样转发给上游，响应体原样返回，
 * 因此前端看到的字段与直连 OpenRouter / TypeSafe 完全一致。
 *
 * 启动：
 *   npm run proxy
 *
 * 密钥从项目根目录的 .env 读取（见 .env.example），也接受环境变量覆盖。
 *
 * .env 可配置项：
 *   JEV_API_KEY        上游密钥
 *   JEV_UPSTREAM       上游端点
 *   JEV_DEFAULT_MODEL  请求未指定 model 时使用的模型
 *   JEV_PROXY_PORT     监听端口，默认 8787
 */

import { createServer } from 'node:http';
import { applyEnvFile } from './env.mjs';

// 载入 .env（已存在的环境变量优先，不被覆盖）
applyEnvFile();

const PORT = Number(process.env.JEV_PROXY_PORT ?? process.env.PORT ?? 8787);
const API_KEY = process.env.JEV_API_KEY ?? '';
const UPSTREAM = process.env.JEV_UPSTREAM ?? 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = process.env.JEV_DEFAULT_MODEL ?? 'typesafe/jev-1.13';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** 单个决策请求允许的提问数量上限，用于防止请求体被滥用 */
const MAX_QUESTIONS = 24;

/** 读取请求体，带 2MB 上限 */
function readBody(req, limitBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(payload));
}

/** 校验请求体是否符合 Jev 协议，拦截明显畸形的请求 */
function validate(payload) {
  if (!payload || typeof payload !== 'object') return '请求体必须是 JSON 对象';
  if (!payload.state) return '缺少 state 字段';
  const stateType = typeof payload.state;
  if (stateType !== 'string' && stateType !== 'object') return 'state 必须是字符串或对象';

  const questions = payload.questions;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    return 'questions 必须是对象';
  }
  const keys = Object.keys(questions);
  if (keys.length === 0) return 'questions 不能为空';
  if (keys.length > MAX_QUESTIONS) return `questions 最多 ${MAX_QUESTIONS} 个`;

  for (const [key, q] of Object.entries(questions)) {
    if (!q || typeof q !== 'object') return `问题 ${key} 格式错误`;
    if (!['choice', 'score', 'noul'].includes(q.type)) {
      return `问题 ${key} 的 type 必须是 choice / score / noul`;
    }
    if (!q.instructions) return `问题 ${key} 缺少 instructions`;
    if (q.type === 'choice') {
      if (!q.criteria || typeof q.criteria !== 'object') {
        return `问题 ${key} 缺少 criteria`;
      }
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria)) return `问题 ${key} 的 criteria 必须是数组`;
      if (q.criteria.length < 2 || q.criteria.length > 10) {
        return `问题 ${key} 的 criteria 需要 2~10 档`;
      }
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      hasKey: Boolean(API_KEY),
      upstream: UPSTREAM,
      defaultModel: DEFAULT_MODEL,
    });
    return;
  }

  /**
   * 把服务端配置下发给前端。
   *
   * 这是让 .env 成为唯一真源的关键：前端的密钥、端点、模型
   * 都从这里取，无需在浏览器里手工填写。
   * 绑定 localhost 使用；部署到公网前务必加上鉴权。
   */
  if (req.url === '/jev/config') {
    sendJson(res, 200, {
      hasKey: Boolean(API_KEY),
      apiKey: API_KEY,
      upstream: UPSTREAM,
      defaultModel: DEFAULT_MODEL,
    });
    return;
  }

  if (req.url !== '/jev/decisions') {
    sendJson(res, 404, { error: { message: 'Not Found' } });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return;
  }

  if (!API_KEY) {
    sendJson(res, 500, { error: { message: '服务端未配置 JEV_API_KEY 环境变量' } });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, {
      error: { message: `请求体解析失败: ${err instanceof Error ? err.message : err}` },
    });
    return;
  }

  const invalid = validate(payload);
  if (invalid) {
    sendJson(res, 422, { error: { message: invalid } });
    return;
  }

  const body = {
    ...payload,
    model: payload.model ?? DEFAULT_MODEL,
  };

  const upstream = new AbortController();
  const timer = setTimeout(() => upstream.abort(), 30_000);

  try {
    const upstreamRes = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: upstream.signal,
    });

    const text = await upstreamRes.text();
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json', ...CORS });
    res.end(text);
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? '上游请求超时'
        : err instanceof Error
          ? err.message
          : String(err);
    sendJson(res, 502, { error: { message } });
  } finally {
    clearTimeout(timer);
  }
});

server.listen(PORT, () => {
  console.log(`[jev-proxy] listening on http://localhost:${PORT}`);
  console.log(`[jev-proxy] upstream:  ${UPSTREAM}`);
  console.log(`[jev-proxy] model:     ${DEFAULT_MODEL}`);
  console.log(
    `[jev-proxy] api key:   ${API_KEY ? 'loaded' : 'MISSING (设置 JEV_API_KEY 后生效)'}`,
  );
});
