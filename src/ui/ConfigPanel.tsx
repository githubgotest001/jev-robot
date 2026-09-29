import { useState } from 'react';
import { DEFAULT_CONFIG, ENDPOINT_PRESETS, clearConfig, saveConfig } from '../jev/config';
import type { JevConfig } from '../jev/config';
import { fetchProxyConfig, mergeProxyConfig } from '../jev/proxyConfig';

interface ConfigPanelProps {
  config: JevConfig;
  onChange: (config: JevConfig) => void;
}

type Status = { kind: 'idle' | 'ok' | 'error' | 'testing'; text: string };

/**
 * Jev 配置面板。
 *
 * 与生成式模型不同，Jev 没有 system prompt / temperature / max_tokens，
 * 这里只暴露真正影响决策的参数：接入点、模型、阈值策略与 state 输入。
 */
export function ConfigPanel({ config, onChange }: ConfigPanelProps) {
  const [draft, setDraft] = useState<JevConfig>(config);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' });
  const [showKey, setShowKey] = useState(false);

  const patch = <K extends keyof JevConfig>(key: K, value: JevConfig[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const patchPolicy = (key: keyof JevConfig['policy'], value: number) => {
    setDraft((prev) => ({ ...prev, policy: { ...prev.policy, [key]: value } }));
  };

  const apply = () => {
    saveConfig(draft);
    onChange(draft);
    setStatus({ kind: 'ok', text: '配置已保存并生效' });
  };

  const restoreDefaults = () => {
    clearConfig();
    onChange({ ...DEFAULT_CONFIG });
    setStatus({ kind: 'ok', text: '已恢复默认配置' });
  };

  /** 手动从本地代理重新拉取 .env 里的密钥 */
  const loadFromEnv = async () => {
    setStatus({ kind: 'testing', text: '正在从 .env 读取…' });
    const proxy = await fetchProxyConfig();
    if (!proxy) {
      setStatus({ kind: 'error', text: '未连接到本地代理，请先运行 npm run proxy' });
      return;
    }
    if (!proxy.hasKey) {
      setStatus({ kind: 'error', text: '.env 中 JEV_API_KEY 为空' });
      return;
    }
    const merged = { ...mergeProxyConfig(draft, proxy), mode: 'remote' as const };
    setDraft(merged);
    onChange(merged);
    setStatus({ kind: 'ok', text: `已从 .env 载入密钥与端点（${proxy.defaultModel}）` });
  };

  /** 连通性测试：发一个最小的 noul 问题 */
  const testConnection = async () => {
    if (draft.mode !== 'remote') {
      setStatus({ kind: 'ok', text: '当前为 Mock 模式，无需连接测试' });
      return;
    }
    if (!draft.apiKey) {
      setStatus({ kind: 'error', text: '未填写 API Key；若使用本地代理可留空' });
      return;
    }
    setStatus({ kind: 'testing', text: '测试中…' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), draft.timeoutMs);
    const started = performance.now();

    try {
      const res = await fetch(draft.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${draft.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: draft.model,
          state: '连通性测试',
          questions: {
            reachable: { type: 'noul', instructions: '这是一个连通性测试。' },
          },
        }),
      });
      const elapsed = Math.round(performance.now() - started);

      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        setStatus({ kind: 'error', text: `HTTP ${res.status} · ${raw.slice(0, 160)}` });
        return;
      }
      const data = (await res.json()) as { answers?: Record<string, { noul?: number }> };
      const noul = data.answers?.reachable?.noul;
      setStatus({
        kind: 'ok',
        text: `连接成功 · ${elapsed}ms · noul=${typeof noul === 'number' ? noul.toFixed(2) : 'n/a'}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', text: `请求失败：${msg}` });
    } finally {
      clearTimeout(timer);
    }
  };

  const activePreset = ENDPOINT_PRESETS.find((p) => p.endpoint === draft.endpoint)?.id;

  return (
    <section className="config-panel">
      <header className="panel-header">
        <h2>Jev 决策模型</h2>
        <div className="header-actions">
          <button className="ghost-btn" onClick={loadFromEnv}>
            从 .env 加载
          </button>
          <button className="ghost-btn" onClick={restoreDefaults}>
            恢复默认
          </button>
          <button className="ghost-btn" onClick={testConnection}>
            {status.kind === 'testing' ? '测试中…' : '测试连接'}
          </button>
          <button className="primary-btn" onClick={apply}>
            保存
          </button>
        </div>
      </header>

      {status.text && <div className={`status-bar ${status.kind}`}>{status.text}</div>}

      <div className="config-scroll">
        <fieldset>
          <legend>接入模式</legend>
          <div className="radio-row">
            <label className={draft.mode === 'mock' ? 'active' : ''}>
              <input
                type="radio"
                checked={draft.mode === 'mock'}
                onChange={() => patch('mode', 'mock')}
              />
              <div>
                <b>Mock 模拟</b>
                <small>离线跑通全链路，不消耗额度，仅供开发调试</small>
              </div>
            </label>
            <label className={draft.mode === 'remote' ? 'active' : ''}>
              <input
                type="radio"
                checked={draft.mode === 'remote'}
                onChange={() => patch('mode', 'remote')}
              />
              <div>
                <b>真实 Jev</b>
                <small>调用托管决策模型，$0.042/百万输入 token</small>
              </div>
            </label>
          </div>
        </fieldset>

        <fieldset className={draft.mode !== 'remote' ? 'disabled' : ''}>
          <legend>接入点</legend>

          <div className="preset-row">
            {ENDPOINT_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`preset-btn ${activePreset === p.id ? 'active' : ''}`}
                title={p.hint}
                onClick={() =>
                  setDraft((prev) => ({ ...prev, endpoint: p.endpoint, model: p.model }))
                }
              >
                {p.label}
              </button>
            ))}
          </div>

          <label className="field">
            <span>端点</span>
            <input
              value={draft.endpoint}
              placeholder="https://openrouter.ai/api/alpha/decisions"
              onChange={(e) => patch('endpoint', e.target.value)}
            />
          </label>

          <label className="field">
            <span>
              模型
              <em className="tip">固定版本如 typesafe/jev-1.13，跟随最新版用 jev-latest</em>
            </span>
            <input
              value={draft.model}
              placeholder="typesafe/jev-1.13"
              onChange={(e) => patch('model', e.target.value)}
            />
          </label>

          <label className="field">
            <span>
              API Key
              <em className="tip">走本地代理时留空，密钥配在服务端环境变量</em>
            </span>
            <div className="inline">
              <input
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                placeholder="sk-or-v1-..."
                autoComplete="off"
                onChange={(e) => patch('apiKey', e.target.value)}
              />
              <button className="ghost-btn sm" onClick={() => setShowKey((v) => !v)}>
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </label>

          <div className="grid-2">
            <label className="field">
              <span>超时（毫秒）</span>
              <input
                type="number"
                value={draft.timeoutMs}
                min={1000}
                step={500}
                onChange={(e) => patch('timeoutMs', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>重试次数 · {draft.maxRetries}</span>
              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={draft.maxRetries}
                onChange={(e) => patch('maxRetries', Number(e.target.value))}
              />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>决策阈值</legend>
          <p className="fieldset-note">
            Jev 的 confidence 衡量分布集中度，不代表正确率。
            阈值需按你的容错成本自定：达到自动执行线才直接动作。
          </p>

          <label className="field">
            <span>
              自动执行阈值 · {draft.policy.autoActThreshold.toFixed(2)}
              <em className="tip">intent confidence ≥ 此值时直接执行</em>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.policy.autoActThreshold}
              onChange={(e) => patchPolicy('autoActThreshold', Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span>
              兜底阈值 · {draft.policy.reviewThreshold.toFixed(2)}
              <em className="tip">低于此值按未知意图处理并给引导选项</em>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.policy.reviewThreshold}
              onChange={(e) => patchPolicy('reviewThreshold', Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span>
              安全阈值 · {draft.policy.safetyThreshold.toFixed(2)}
              <em className="tip">safe_to_execute 的 noul 低于此值拦截动作</em>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.policy.safetyThreshold}
              onChange={(e) => patchPolicy('safetyThreshold', Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span>
              澄清阈值 · {draft.policy.clarificationThreshold.toFixed(2)}
              <em className="tip">needs_clarification 的 noul 高于此值则先反问</em>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.policy.clarificationThreshold}
              onChange={(e) => patchPolicy('clarificationThreshold', Number(e.target.value))}
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>环境输入（state）</legend>
          <label className="field">
            <span>
              用户距离 · {draft.userDistanceCm} cm
            </span>
            <input
              type="range"
              min={10}
              max={300}
              step={10}
              value={draft.userDistanceCm}
              onChange={(e) => patch('userDistanceCm', Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span>环境描述</span>
            <textarea
              rows={2}
              value={draft.environment}
              onChange={(e) => patch('environment', e.target.value)}
            />
          </label>

          <div className="switch-grid">
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.hardware.camera}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    hardware: { ...p.hardware, camera: e.target.checked },
                  }))
                }
              />
              <span>摄像头</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.hardware.speaker}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    hardware: { ...p.hardware, speaker: e.target.checked },
                  }))
                }
              />
              <span>扬声器</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.hardware.mobility}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    hardware: { ...p.hardware, mobility: e.target.checked },
                  }))
                }
              />
              <span>移动底盘</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.hardware.arm}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    hardware: { ...p.hardware, arm: e.target.checked },
                  }))
                }
              />
              <span>机械臂</span>
            </label>
          </div>

          <div className="switch-grid">
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.safety.humanTooClose}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    safety: { ...p.safety, humanTooClose: e.target.checked },
                  }))
                }
              />
              <span>人距离过近</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.safety.obstacleDetected}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    safety: { ...p.safety, obstacleDetected: e.target.checked },
                  }))
                }
              />
              <span>检测到障碍物</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.safety.emergencyStop}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    safety: { ...p.safety, emergencyStop: e.target.checked },
                  }))
                }
              />
              <span>紧急停止</span>
            </label>
          </div>

          <p className="fieldset-note">
            关闭硬件或打开安全标志后，Jev 的 safe_to_execute 会给出低 noul，
            机器人将只做拒绝回应而不执行动作——用来演示安全闸门。
          </p>

          <label className="switch">
            <input
              type="checkbox"
              checked={draft.showDebug}
              onChange={(e) => patch('showDebug', e.target.checked)}
            />
            <span>
              展示 Jev 原始判定
              <small>显示 choice 概率分布、noul 值、score 图例与决策路径</small>
            </span>
          </label>
        </fieldset>
      </div>
    </section>
  );
}
