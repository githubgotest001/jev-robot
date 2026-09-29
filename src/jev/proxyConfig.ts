import type { JevConfig } from './config';

/** 代理下发的服务端配置 */
interface ProxyConfig {
  hasKey: boolean;
  apiKey: string;
  upstream: string;
  defaultModel: string;
}

/** 默认的代理地址，与 vite dev server 的转发规则对应 */
export const DEFAULT_PROXY_ENDPOINT = 'http://localhost:8787/jev/decisions';

function proxyConfigUrl(): string {
  try {
    const url = new URL(DEFAULT_PROXY_ENDPOINT);
    return url.protocol + '//' + url.host + '/jev/config';
  } catch {
    return '';
  }
}

/**
 * 从本地代理拉取服务端配置（密钥、端点、模型）。
 *
 * 目的：让项目根目录的 .env 成为唯一真源——
 * 密钥只在服务端存在，前端启动时自动获取，无需手工填写。
 * 代理不可用时返回 null，调用方回落到本地配置。
 */
export async function fetchProxyConfig(timeoutMs = 3000): Promise<ProxyConfig | null> {
  const url = proxyConfigUrl();
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<ProxyConfig>;
    if (typeof data.apiKey !== 'string') return null;
    return {
      hasKey: Boolean(data.hasKey),
      apiKey: data.apiKey,
      upstream: typeof data.upstream === 'string' ? data.upstream : '',
      defaultModel: typeof data.defaultModel === 'string' ? data.defaultModel : '',
    };
  } catch {
    // 代理未启动属正常情况，静默回落
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 把代理下发的配置合并进本地配置 */
export function mergeProxyConfig(config: JevConfig, proxy: ProxyConfig): JevConfig {
  return {
    ...config,
    endpoint: proxy.upstream || config.endpoint,
    model: proxy.defaultModel || config.model,
    apiKey: proxy.apiKey || config.apiKey,
  };
}

/** 代理地址对应的预设 id，用于配置页高亮 */
export function isProxyEndpoint(endpoint: string): boolean {
  return endpoint === DEFAULT_PROXY_ENDPOINT;
}
