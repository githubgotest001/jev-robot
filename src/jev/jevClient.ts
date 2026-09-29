import type { JevErrorResponse, JevRequest, JevResponse } from './jevTypes';
import { isProxyEndpoint } from './jevTypes';

const RETRYABLE = new Set([429, 529, 502, 503, 504]);

export interface JevClientConfig {
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  /** 走本地代理：密钥由代理注入，前端不发送 Authorization */
  useProxy: boolean;
}

export class JevError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  /** 失败请求的传输细节，用于让面板也能看到"出错时到底发了什么、回了什么" */
  readonly transport?: JevTransport;
  constructor(message: string, status: number, transport?: JevTransport) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.retryable = RETRYABLE.has(status);
    this.transport = transport;
  }
}

/**
 * 一次调用的传输层细节，供判定面板的「原始报文」视图使用。
 *
 * 这里刻意记下真正发出去的请求体与响应原文，而不是让界面重新拼一份——
 * 重新拼出来的副本会与实现悄悄漂移，那就失去了"看原始数据"的意义。
 */
export interface JevTransport {
  /** 实际请求的 URL */
  url: string;
  /** 实际发送的请求头（密钥已脱敏） */
  headers: Record<string, string>;
  /** 序列化后的请求体原文 */
  requestBody: string;
  /** HTTP 状态码；网络层失败时为 0 */
  status: number;
  /** 响应体原文，未经 JSON.parse */
  responseText: string;
  /** 总耗时，含重试与退避等待 */
  totalMs: number;
  /** 从发出请求到收到响应头的耗时，用来把网络/排队与模型计算区分开 */
  ttfbMs: number;
  /** 实际发起次数，>1 说明发生过重试 */
  attempts: number;
}

/** 调用结果 + 传输细节 */
export interface JevCallResult {
  response: JevResponse;
  transport: JevTransport;
}

/** 密钥脱敏：留前 6 位与后 4 位，既能核对是哪把钥匙，又不至于泄露 */
export function maskSecret(value: string): string {
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function backoffDelay(attempt: number): number {
  const base = Math.min(4000, 300 * Math.pow(2, attempt));
  return base + Math.random() * 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JevClient {
  private readonly config: JevClientConfig;

  constructor(config: JevClientConfig) {
    this.config = config;
  }

  async evaluate(request: JevRequest): Promise<JevResponse> {
    const { response } = await this.evaluateDetailed(request);
    return response;
  }

  /**
   * 与 evaluate 同一条实现路径，额外回报传输细节。
   * 两者共用这段循环，避免出现"界面看到的"和"实际发送的"两套逻辑。
   */
  async evaluateDetailed(request: JevRequest): Promise<JevCallResult> {
    const { endpoint, apiKey, timeoutMs, maxRetries, useProxy } = this.config;

    /**
     * 直连模式必须有密钥，否则不要发出去。
     *
     * 空 Authorization 会让上游回退到 cookie 鉴权，报出
     * "No cookie auth credentials found" 这类与真实原因无关的错误，
     * 排查时会误以为是密钥写错。这里直接给出准确提示。
     */
    if (!useProxy && !apiKey) {
      throw new JevError(
        isProxyEndpoint(endpoint)
          ? '本地代理需要先启动：npm run proxy'
          : `未配置 API Key，请在配置页填写 ${endpoint} 对应的密钥（或改用本地代理）`,
        401,
      );
    }

    const requestBody = JSON.stringify(request);
    /**
     * 面板里展示的请求头用脱敏版本；真正 fetch 时另用真实密钥。
     * 两者由同一个来源推导，不会出现"显示的键"和"实际发的键"不一致。
     */
    const displayHeaders = buildHeaders(useProxy, apiKey ? maskSecret(apiKey) : '');
    const startedAt = performance.now();
    let lastError: JevError | null = null;
    /** 已完成并失败（含重试）的请求数，用于在最终成功时还原真实尝试次数 */
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const attemptStart = performance.now();
      attempts += 1;

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: buildHeaders(useProxy, apiKey),
          body: requestBody,
          signal: controller.signal,
        });
        const ttfbMs = Math.round(performance.now() - attemptStart);
        const responseText = await res.text();

        if (!res.ok) {
          throw new JevError(extractErrorMessage(responseText, res.status), res.status, {
            url: endpoint,
            headers: displayHeaders,
            requestBody,
            status: res.status,
            responseText,
            totalMs: Math.round(performance.now() - startedAt),
            ttfbMs,
            attempts,
          });
        }

        let data: JevResponse;
        try {
          data = JSON.parse(responseText) as JevResponse;
        } catch {
          throw new JevError('响应不是合法 JSON', 500);
        }
        if (!data || typeof data !== 'object' || !data.answers) {
          throw new JevError('响应体缺少 answers 字段', 500);
        }

        return {
          response: data,
          transport: {
            url: endpoint,
            headers: displayHeaders,
            requestBody,
            status: res.status,
            responseText,
            totalMs: Math.round(performance.now() - startedAt),
            ttfbMs,
            attempts,
          },
        };
      } catch (err) {
        if (err instanceof JevError) {
          lastError = err;
          if (!err.retryable || attempt === maxRetries) throw err;
        } else if (err instanceof Error && err.name === 'AbortError') {
          lastError = new JevError(`请求超时 ${timeoutMs}ms`, 408, {
            url: endpoint,
            headers: displayHeaders,
            requestBody,
            status: 0,
            responseText: '',
            totalMs: Math.round(performance.now() - startedAt),
            ttfbMs: Math.round(performance.now() - attemptStart),
            attempts,
          });
          if (attempt === maxRetries) throw lastError;
        } else {
          lastError = new JevError(err instanceof Error ? err.message : String(err), 0, {
            url: endpoint,
            headers: displayHeaders,
            requestBody,
            status: 0,
            responseText: '',
            totalMs: Math.round(performance.now() - startedAt),
            ttfbMs: Math.round(performance.now() - attemptStart),
            attempts,
          });
          if (attempt === maxRetries) throw lastError;
        }
        await sleep(backoffDelay(attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new JevError('决策请求失败', 0);
  }
}

/** 组装请求头；apiKey 为空时不带 Authorization（走代理时由代理注入） */
function buildHeaders(useProxy: boolean, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!useProxy && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function extractErrorMessage(raw: string, status: number): string {
  if (!raw) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(raw) as JevErrorResponse;
    return parsed.error?.message ?? parsed.message ?? `HTTP ${status}`;
  } catch {
    return raw.slice(0, 200);
  }
}
