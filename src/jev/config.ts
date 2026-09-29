import type { DecisionPolicy } from './jevProvider';
import { DEFAULT_POLICY } from './jevProvider';

/**
 * Jev 接入配置。
 *
 * Jev 是非生成式决策模型，没有 system prompt、没有 temperature、
 * 没有 max_tokens 这些参数——配置项只围绕"连到哪、用哪个模型、
 * 阈值怎么定"这三件事。
 */
export interface JevConfig {
  mode: 'mock' | 'remote';
  /**
   * Jev 端点。
   * OpenRouter：https://openrouter.ai/api/alpha/decisions
   * TypeSafe：  https://api.typesafe.ai/v1/systemone
   * 本地代理：  http://localhost:8787/jev/decisions
   */
  endpoint: string;
  /** 模型标识，如 typesafe/jev-1.13 或 jev-latest */
  model: string;
  /** API Key。走本地代理时留空，由代理从 .env 注入 */
  apiKey: string;
  /** 配置是否由本地代理下发（.env 管理），界面上只读展示 */
  proxyManaged: boolean;
  timeoutMs: number;
  maxRetries: number;
  policy: DecisionPolicy;
  /** 是否在界面上展示 Jev 的原始判定与概率分布 */
  showDebug: boolean;
  userDistanceCm: number;
  environment: string;
  hardware: { camera: boolean; speaker: boolean; mobility: boolean; arm: boolean };
  safety: { emergencyStop: boolean; humanTooClose: boolean; obstacleDetected: boolean };
}

export const DEFAULT_CONFIG: JevConfig = {
  mode: 'mock',
  endpoint: 'http://localhost:8787/jev/decisions',
  model: 'typesafe/jev-1.13',
  apiKey: '',
  proxyManaged: false,
  timeoutMs: 15000,
  maxRetries: 2,
  policy: { ...DEFAULT_POLICY },
  showDebug: true,
  userDistanceCm: 120,
  environment: '客厅，地面平整，前方 1.5 米无遮挡',
  hardware: { camera: true, speaker: true, mobility: true, arm: true },
  safety: { emergencyStop: false, humanTooClose: false, obstacleDetected: false },
};

const STORAGE_KEY = 'jev-robot.jev-config.v2';

function cloneDefault(): JevConfig {
  return {
    ...DEFAULT_CONFIG,
    policy: { ...DEFAULT_POLICY },
    hardware: { ...DEFAULT_CONFIG.hardware },
    safety: { ...DEFAULT_CONFIG.safety },
  };
}

export function loadConfig(): JevConfig {
  if (typeof window === 'undefined') return cloneDefault();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefault();
    return sanitizeConfig({ ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<JevConfig>) });
  } catch {
    return cloneDefault();
  }
}

export function saveConfig(config: JevConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // 隐私模式下不可用，静默降级
  }
}

export function clearConfig(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上
  }
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** 校验并归一化配置，防止非法值流入请求层 */
export function sanitizeConfig(config: JevConfig): JevConfig {
  const d = cloneDefault();
  return {
    mode: config.mode === 'remote' ? 'remote' : 'mock',
    endpoint: String(config.endpoint ?? d.endpoint).trim(),
    model: String(config.model ?? d.model).trim(),
    apiKey: String(config.apiKey ?? ''),
    proxyManaged: Boolean(config.proxyManaged),
    timeoutMs: clamp(Math.round(Number(config.timeoutMs)), 1000, 120000),
    maxRetries: clamp(Math.round(Number(config.maxRetries)), 0, 5),
    policy: {
      autoActThreshold: clamp(Number(config.policy?.autoActThreshold), 0, 1),
      reviewThreshold: clamp(Number(config.policy?.reviewThreshold), 0, 1),
      safetyThreshold: clamp(Number(config.policy?.safetyThreshold), 0, 1),
    },
    showDebug: Boolean(config.showDebug),
    userDistanceCm: clamp(Math.round(Number(config.userDistanceCm)), 10, 500),
    environment: String(config.environment ?? d.environment),
    hardware: {
      camera: Boolean(config.hardware?.camera),
      speaker: Boolean(config.hardware?.speaker),
      mobility: Boolean(config.hardware?.mobility),
      arm: Boolean(config.hardware?.arm),
    },
    safety: {
      emergencyStop: Boolean(config.safety?.emergencyStop),
      humanTooClose: Boolean(config.safety?.humanTooClose),
      obstacleDetected: Boolean(config.safety?.obstacleDetected),
    },
  };
}

/** 常用端点预设，便于配置页一键切换 */
export const ENDPOINT_PRESETS = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    model: 'typesafe/jev-1.13',
    hint: 'key 以 sk-or-v1- 开头',
  },
  {
    id: 'typesafe',
    label: 'TypeSafe 官方',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    hint: 'key 以 sk_ 开头',
  },
  {
    id: 'proxy',
    label: '本地代理',
    endpoint: 'http://localhost:8787/jev/decisions',
    model: 'typesafe/jev-1.13',
    hint: '推荐，密钥留在服务端',
  },
] as const;
