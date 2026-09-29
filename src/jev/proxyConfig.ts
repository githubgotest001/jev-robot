import type { JevConfig } from './config';
import { DEFAULT_PROXY_ENDPOINT } from './jevTypes';

export { DEFAULT_PROXY_ENDPOINT, isProxyEndpoint } from './jevTypes';

/** 代理下发的服务端配置 */
interface ProxyConfig {
  hasKey: boolean;
  apiKey: string;
  upstream: string;
  defaultModel: string;
}

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

/**
 * 把代理下发的配置合并进本地配置。
 *
 * endpoint 保持指向本地代理，不改成上游地址——
 * 前端只与代理通信，密钥由代理从 .env 读取后注入，
 * 既避免密钥进浏览器，也绕开浏览器直连上游的鉴权问题。
 */
export function mergeProxyConfig(config: JevConfig, proxy: ProxyConfig): JevConfig {
  return {
    ...config,
    endpoint: DEFAULT_PROXY_ENDPOINT,
    model: proxy.defaultModel || config.model,
    // 前端无需持有密钥，留空由代理注入
    apiKey: '',
    /** 标记配置来自代理，用于界面提示；不要拿它当"是否走代理"的判据 */
    proxyManaged: true,
  };
}
