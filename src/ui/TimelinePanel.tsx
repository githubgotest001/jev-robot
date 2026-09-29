import { ACTION_LIBRARY, ACTION_MAP } from '../domain/actionLibrary';
import type { RobotAction } from '../domain/types';
import type { TimelineEvent } from '../engine/simulationEngine';
import type { JevDecisionResult } from '../jev/jevProvider';

interface TimelinePanelProps {
  timeline: TimelineEvent[];
  onPreview: (action: RobotAction) => void;
  /** 最近一次 Jev 判定，用于展示概率分布 */
  decision: JevDecisionResult | null;
}

const STATUS_LABEL: Record<TimelineEvent['status'], string> = {
  running: '执行中',
  done: '完成',
  interrupted: '被打断',
  failed: '失败',
};

const GROUP_NAME: Record<string, string> = {
  head: '头部云台',
  screen: '屏幕表情',
  arm: '机械臂',
  base: '移动底盘',
  audio: '声音',
  body: '待机身体',
};

export function TimelinePanel({ timeline, onPreview, decision }: TimelinePanelProps) {
  const recent = timeline.slice(-12).reverse();
  const grouped = groupByActuator();

  return (
    <section className="timeline-panel">
      <header className="panel-header">
        <h2>Jev 判定</h2>
        {decision && (
          <span className={`counter mode-${decision.mode}`}>
            {decision.mode === 'jev' ? 'JEV' : '降级'}
          </span>
        )}
      </header>

      <div className="decision-pane">
        {!decision ? (
          <p className="empty-hint">说一句话，这里会显示 Jev 的判定与概率分布</p>
        ) : (
          <DecisionView decision={decision} />
        )}
      </div>

      <div className="timeline-list">
        {recent.length === 0 && <p className="empty-hint">动作执行轨迹</p>}
        {recent.map((ev) => {
          const action = ACTION_MAP.get(ev.actionId);
          return (
            <div key={ev.id} className={`tl-item ${ev.status}`}>
              <span className="tl-dot" />
              <div className="tl-body">
                <div className="tl-head">
                  <b>{ev.label}</b>
                  <em>{STATUS_LABEL[ev.status]}</em>
                </div>
                <div className="tl-meta">
                  <code>{ev.actionId}</code>
                  {action && <span className="tl-actuators">{action.actuators.join('+')}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="library">
        <h3>动作库 · {ACTION_LIBRARY.length}</h3>
        <p className="hint">点击任意动作直接播放，用于单独调试</p>
        <div className="lib-groups">
          {grouped.map(([group, items]) => (
            <div key={group} className="lib-group">
              <h4>{group}</h4>
              <div className="lib-items">
                {items.map((a) => (
                  <button
                    key={a.id}
                    className="lib-btn"
                    title={a.description}
                    onClick={() => onPreview(a)}
                  >
                    {a.label}
                    <em>{a.durationMs}ms</em>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Jev 判定的可视化：choice 概率条、noul 刻度、score 图例 */
function DecisionView({ decision }: { decision: JevDecisionResult }) {
  const { raw } = decision;

  return (
    <div className="decision-body">
      <div className="decision-head">
        <span className="intent-tag">
          <em>intent</em>
          <b>{decision.intent}</b>
        </span>
        <span className="intent-tag">
          <em>style</em>
          <b>{decision.style}</b>
        </span>
        <span className="intent-tag">
          <em>emotion</em>
          <b>{decision.emotion}</b>
        </span>
        {!decision.executed && <span className="blocked-tag">已拦截</span>}
      </div>

      <ul className="trace-list">
        {decision.trace.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>

      {raw.intent && (
        <div className="prob-block">
          <h5>
            intent 概率分布
            <span className="conf">confidence {raw.intent.confidence.toFixed(2)}</span>
          </h5>
          <ProbBars
            probabilities={raw.intent.probabilities}
            highlight={raw.intent.choice}
            max={5}
          />
        </div>
      )}

      {raw.gestureStyle && (
        <div className="prob-block">
          <h5>
            gesture_style 概率分布
            <span className="conf">confidence {raw.gestureStyle.confidence.toFixed(2)}</span>
          </h5>
          <ProbBars
            probabilities={raw.gestureStyle.probabilities}
            highlight={raw.gestureStyle.choice}
            max={4}
          />
        </div>
      )}

      {raw.safeToExecute && (
        <NoulGauge label="safe_to_execute" value={raw.safeToExecute.noul} positiveIsGood />
      )}

      <div className="decision-foot">
        {decision.model && <span>模型 {decision.model}</span>}
        <span>{decision.latencyMs}ms</span>
        {decision.usage && decision.usage.inputTokens > 0 && (
          <span>
            {decision.usage.inputTokens} in / {decision.usage.outputTokens} out
            {decision.usage.costUsd !== undefined &&
              ` · $${decision.usage.costUsd.toFixed(6)}`}
          </span>
        )}
      </div>

      {decision.error && <p className="decision-error">{decision.error}</p>}
    </div>
  );
}

/** 概率条：按概率降序取前 N 项 */
function ProbBars({
  probabilities,
  highlight,
  max = 5,
}: {
  probabilities: Record<string, number>;
  highlight: string;
  max?: number;
}) {
  const entries = Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);

  // 以最大值作为满格基准，否则全是 0.0x 时所有条都几乎不可见
  const peak = Math.max(...entries.map(([, v]) => v), 0.0001);

  return (
    <div className="prob-bars">
      {entries.map(([key, prob]) => (
        <div
          key={key}
          className={`prob-row ${key === highlight ? 'hit' : ''} ${prob <= 0 ? 'zero' : ''}`}
        >
          <span className="prob-key" title={key}>
            {key}
          </span>
          <div className="prob-track">
            {prob > 0 && (
              <div
                className="prob-fill"
                style={{ width: `${Math.max(3, (prob / peak) * 100)}%` }}
              />
            )}
          </div>
          <span className="prob-val">{prob.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

/** Noul 刻度条：0~1 的概率 */
function NoulGauge({
  label,
  value,
  positiveIsGood,
}: {
  label: string;
  value: number;
  positiveIsGood: boolean;
}) {
  const good = positiveIsGood ? value >= 0.6 : value < 0.6;
  return (
    <div className="noul">
      <span className="noul-label">{label}</span>
      <div className="noul-track">
        <div
          className={`noul-fill ${good ? 'ok' : 'bad'}`}
          style={{ width: `${Math.max(2, value * 100)}%` }}
        />
      </div>
      <span className="noul-val">{value.toFixed(2)}</span>
    </div>
  );
}

/** 按执行器分组展示动作库 */
function groupByActuator(): [string, RobotAction[]][] {
  const map = new Map<string, RobotAction[]>();
  for (const action of ACTION_LIBRARY) {
    const primary = action.actuators[0] ?? 'other';
    const list = map.get(primary) ?? [];
    list.push(action);
    map.set(primary, list);
  }
  return [...map.entries()].map(([k, v]) => [GROUP_NAME[k] ?? k, v]);
}