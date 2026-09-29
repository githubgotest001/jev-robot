import type { JevErrorResponse, JevRequest, JevResponse } from './jevTypes';

const RETRYABLE = new Set([429, 529, 502, 503, 504]);

export interface JevClientConfig {
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
}

export class JevError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.retryable = RETRYABLE.has(status);
  }
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
    const { endpoint, apiKey, timeoutMs, maxRetries } = this.config;

    if (!apiKey) {
      throw new JevError('未配置 API Key，请检查 JEV 配置或启动本地代理', 401);
    }

    let lastError: JevError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        if (!res.ok) {
          const raw = await res.text().catch(() => '');
          throw new JevError(extractErrorMessage(raw, res.status), res.status);
        }

        const data = (await res.json()) as JevResponse;
        if (!data || typeof data !== 'object' || !data.answers) {
          throw new JevError('响应体缺少 answers 字段', 500);
        }
        return data;
      } catch (err) {
        if (err instanceof JevError) {
          lastError = err;
          if (!err.retryable || attempt === maxRetries) throw err;
        } else if (err instanceof Error && err.name === 'AbortError') {
          lastError = new JevError(`请求超时 ${timeoutMs}ms`, 408);
          if (attempt === maxRetries) throw lastError;
        } else {
          lastError = new JevError(err instanceof Error ? err.message : String(err), 0);
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

function extractErrorMessage(raw: string, status: number): string {
  if (!raw) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(raw) as JevErrorResponse;
    return parsed.error?.message ?? parsed.message ?? `HTTP ${status}`;
  } catch {
    return raw.slice(0, 200);
  }
}
