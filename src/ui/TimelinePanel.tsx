import { useEffect, useRef, useState } from 'react';
import type { TimelineEvent } from '../engine/simulationEngine';
import type { DecisionPolicy, JevDecisionResult, JevTrace } from '../jev/jevProvider';

interface TimelinePanelProps {
  /** 最近一次 Jev 判定，用于展示概率分布 */
  decision: JevDecisionResult | null;
  /** 当前阈值策略，用于在概率条上标出决策边界 */
  policy: DecisionPolicy;
  /** 决策时喂给 Jev 的状态摘要，用于解释"为什么判成这样" */
  state: DecisionState;
}

/**
 * 判定输入的可视化摘要。
 *
 * 与 buildState() 送进 prompt 的字段同名同义——不在 UI 里另造一套说法，
 * 否则界面显示的输入和真正参与判定的输入会悄悄漂移。
 */
export interface DecisionState {
  utterance: string;
  userDistanceCm: number;
  environment: string;
  battery: number;
  busy: boolean;
  currentActionId: string | null;
  hardware: { camera: boolean; speaker: boolean; mobility: boolean; arm: boolean };
}

const HARDWARE_LABEL: Record<keyof DecisionState['hardware'], string> = {
  camera: '摄像头',
  speaker: '扬声器',
  mobility: '移动底盘',
  arm: '机械臂',
};

const STATUS_LABEL: Record<TimelineEvent['status'], string> = {
  running: '执行中',
  done: '完成',
  interrupted: '被打断',
  failed: '失败',
};

/**
 * 单个 choice 问题最多渲染的候选数。
 *
 * intent 一共 27 个候选，以前只画前 5 个，等于把"模型考虑过什么"藏掉了大半。
 * 面板加宽、轨迹条变扁之后腾出的垂直空间，正好吃下 12 项再加一行汇总。
 */
const MAX_INTENT_ROWS = 12;

export function TimelinePanel({ decision, policy, state }: TimelinePanelProps) {
  /** 原始报文视图默认收起：它是排查用的，不该挤占日常要看的内容 */
  const [showRaw, setShowRaw] = useState(false);

  return (
    <section className="timeline-panel">
      <header className="panel-header">
        <h2>Jev 判定</h2>
        <div className="header-actions">
          {decision && (
            <>
              <span className="counter">{decision.latencyMs}ms</span>
              <span className={`counter mode-${decision.mode}`}>
                {decision.mode === 'jev' ? 'JEV' : '降级'}
              </span>
            </>
          )}
        </div>
      </header>

      {decision && decision.traffic && (
        <button
          className={`raw-toggle ${showRaw ? 'on' : ''}`}
          aria-expanded={showRaw}
          onClick={() => setShowRaw((v) => !v)}
          title="查看这次判定实际发出的请求与上游返回"
        >
          <span className="raw-toggle-caret">{showRaw ? '▾' : '▸'}</span>
          原始报文
          <em>
            {decision.traffic.method} {decision.traffic.status || 'ERR'}
            {decision.traffic.attempts > 1 && ` · 重试 ${decision.traffic.attempts - 1} 次`}
          </em>
        </button>
      )}

      <div className="decision-pane">
        {!decision ? (
          <div className="decision-empty">
            <p className="empty-hint">说一句话，这里会显示 Jev 的判定与概率分布</p>
            <ul className="decision-legend">
              <li>
                <b>choice</b> 概率条：每个候选分到多少权重，竖线是执行 / 反问的阈值
              </li>
              <li>
                <b>noul</b> 刻度：命题成立的概率，中点 0.5 表示「不知道」
              </li>
              <li>
                <b>score</b> 图例：有序档位上的加权落地位置
              </li>
            </ul>
          </div>
        ) : showRaw && decision.traffic ? (
          <RawTraffic traffic={decision.traffic} />
        ) : (
          <>
            <DecisionView decision={decision} policy={policy} />
            <StateStrip state={state} />
          </>
        )}
      </div>
    </section>
  );
}

/**
 * 判定输入摘要。
 *
 * 判定结果读完之后，紧接着要回答的就是"它凭什么这么判"——
 * 电量、硬件开关、安全标志、用户距离正是那几个决定性的输入变量
 * （关掉「移动底盘」就能看到 safe_to_execute 掉到 0.12）。
 * 把状态和结果放在同一屏，因果一目了然，也省掉来回切配置页。
 */
function StateStrip({ state }: { state: DecisionState }) {
  const items: { label: string; value: string; tone?: 'ok' | 'bad' | 'warn' }[] = [
    { label: 'user_speech', value: `「${state.utterance}」` },
    { label: 'user_distance_cm', value: `${state.userDistanceCm}` },
    {
      label: 'battery_percent',
      value: `${state.battery}%`,
      tone: state.battery < 15 ? 'bad' : undefined,
    },
    { label: 'is_busy', value: state.busy ? 'true' : 'false' },
    { label: 'current_action', value: state.currentActionId ?? 'idle' },
    { label: 'environment', value: state.environment },
  ];

  const missing = (Object.keys(HARDWARE_LABEL) as (keyof typeof HARDWARE_LABEL)[]).filter(
    (key) => !state.hardware[key],
  );

  return (
    <div className="state-strip">
      <h5>
        <span>判定输入 state</span>
      </h5>
      <div className="state-grid">
        {items.map((item) => (
          <span key={item.label} className={`state-item ${item.tone ?? ''}`}>
            <em>{item.label}</em>
            <b title={item.value}>{item.value}</b>
          </span>
        ))}
        <span className={`state-item ${missing.length > 0 ? 'bad' : 'ok'}`}>
          <em>hardware</em>
          <b>
            {missing.length === 0
              ? '全部可用'
              : `缺 ${missing.map((k) => HARDWARE_LABEL[k]).join('、')}`}
          </b>
        </span>
      </div>
    </div>
  );
}

/** Jev 判定的可视化：choice 概率条、noul 刻度、score 图例 */
function DecisionView({
  decision,
  policy,
}: {
  decision: JevDecisionResult;
  policy: DecisionPolicy;
}) {
  const { raw } = decision;

  return (
    <div className="decision-body">
      <div className="decision-summary">
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
        <span className={`path-tag path-${decision.path}`}>{decision.pathLabel}</span>
        {!decision.executed && <span className="blocked-tag">已拦截</span>}
      </div>

      {raw.intent && (
        <ProbBlock
          title="intent"
          answer={raw.intent}
          max={MAX_INTENT_ROWS}
          marks={[
            { value: policy.reviewThreshold, label: `反问 ${policy.reviewThreshold}` },
            { value: policy.autoActThreshold, label: `执行 ${policy.autoActThreshold}` },
          ]}
        />
      )}

      {raw.gestureStyle && <ProbBlock title="gesture_style" answer={raw.gestureStyle} max={4} />}

      {raw.safeToExecute && (
        <NoulGauge
          label="safe_to_execute"
          value={raw.safeToExecute.noul}
          threshold={policy.safetyThreshold}
        />
      )}

      {raw.score && <ScoreBlock answer={raw.score} />}

      <div className="decision-foot">
        {decision.model && <span>{decision.model}</span>}
        {decision.usage && decision.usage.inputTokens > 0 && (
          <>
            <span>
              {decision.usage.inputTokens} in / {decision.usage.outputTokens} out
            </span>
            {decision.usage.costUsd !== undefined && (
              <span>${decision.usage.costUsd.toFixed(6)}</span>
            )}
          </>
        )}
      </div>

      {decision.error && <p className="decision-error">{decision.error}</p>}
    </div>
  );
}

/** 一张概率分布卡片：标题 + confidence + 候选行 */
function ProbBlock({
  title,
  answer,
  max,
  marks,
}: {
  title: string;
  answer: { choice: string; confidence: number; probabilities: Record<string, number> };
  max: number;
  marks?: { value: number; label: string }[];
}) {
  const entries = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, max);
  const hidden = entries.slice(max);
  const hiddenMass = hidden.reduce((sum, [, v]) => sum + v, 0);

  return (
    <div className="prob-block">
      <h5>
        <span>
          {title} 概率分布
          {hidden.length > 0 && <em className="prob-cut">取前 {shown.length} 项</em>}
        </span>
        <span className="conf">confidence {answer.confidence.toFixed(2)}</span>
      </h5>
      <div className="prob-bars">
        {shown.map(([key, prob]) => (
          <ProbRow key={key} label={key} value={prob} hit={key === answer.choice} marks={marks} />
        ))}
        {hidden.length > 0 && (
          <ProbRow
            label={`其余 ${hidden.length} 项`}
            value={hiddenMass}
            hit={false}
            muted
            marks={marks}
            title={hidden
              .map(([k, v]) => `${k} ${v.toFixed(2)}`)
              .join('  ')}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 单行候选。
 *
 * 条宽用绝对概率，不用相对峰值：峰值归一化会把 0.01 的项也画成满格，
 * 一眼看去像是有 100% 的分量，反而误导判断。
 * 概率量级差异极大时，短条配合右侧数值仍然读得出差距。
 */
function ProbRow({
  label,
  value,
  hit,
  muted,
  marks,
  title,
}: {
  label: string;
  value: number;
  hit: boolean;
  muted?: boolean;
  marks?: { value: number; label: string }[];
  title?: string;
}) {
  return (
    <div
      className={`prob-row ${hit ? 'hit' : ''} ${muted ? 'muted' : ''} ${value <= 0 ? 'zero' : ''}`}
      title={title}
    >
      <span className="prob-key">{label}</span>
      <div className="prob-track">
        {value > 0 && (
          <div className="prob-fill" style={{ width: `${Math.min(100, value * 100)}%` }} />
        )}
        {marks?.map((m) => (
          <span
            key={m.value}
            className="prob-mark"
            style={{ left: `${m.value * 100}%` }}
            title={`${m.label} 阈值`}
          />
        ))}
      </div>
      <span className="prob-val">{value.toFixed(2)}</span>
    </div>
  );
}

/**
 * Noul 刻度：0~1 的概率。
 *
 * 盘面中点画一条标记线，因为 noul ≈ 0.5 是「模型不知道」——
 * 它是需要单独处理的第三种结果，而不是「偏向否定」。
 */
function NoulGauge({
  label,
  value,
  threshold,
}: {
  label: string;
  value: number;
  threshold: number;
}) {
  const good = value >= threshold;
  return (
    <div className="noul">
      <span className="noul-label" title={`门限 ${threshold}`}>
        {label}
      </span>
      <div className="noul-track">
        <div
          className={`noul-fill ${good ? 'ok' : 'bad'}`}
          style={{ width: `${Math.max(1, value * 100)}%` }}
        />
        <span className="noul-mid" title="0.5 表示模型不知道" />
        <span
          className="prob-mark"
          style={{ left: `${threshold * 100}%` }}
          title={`门限 ${threshold}`}
        />
      </div>
      <span className={`noul-val ${good ? 'ok' : 'bad'}`}>{value.toFixed(2)}</span>
    </div>
  );
}

/** Score 图例：有序档位上的分布柱 + 加权落点 */
function ScoreBlock({
  answer,
}: {
  answer: { score: number; legend: string[]; probabilities: Record<string, number> };
}) {
  const legend = answer.legend;
  const values = legend.map((l) => answer.probabilities[l] ?? 0);
  const peak = Math.max(...values, 0.0001);
  const tone = answer.score >= 7 ? 'ok' : answer.score >= 4 ? 'mid' : 'bad';

  return (
    <div className="prob-block">
      <h5>
        <span>score 档位分布</span>
        <span className={`conf tone-${tone}`}>score {answer.score.toFixed(2)}</span>
      </h5>
      <div className="score-rows">
        {legend.map((name, i) => {
          const p = answer.probabilities[name] ?? 0;
          return (
            <div key={`${name}-${i}`} className="score-row" title={`${i + 1}. ${name} · ${p.toFixed(2)}`}>
              <span className="score-name">{name}</span>
              <div className="score-mark">
                <span style={{ height: `${p > 0 ? Math.max(3, (p / peak) * 100) : 0}%` }} />
              </div>
              <span className="prob-val">{p.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 原始报文视图。
 *
 * 展示这次判定真正发出的请求与上游的原始返回——请求体直接取发送前序列化的原文，
 * 响应体是未加工的响应文本，不在界面里重新拼一份，
 * 否则"看到的"与"实际发的"会悄悄漂移，这个视图就失去意义了。
 *
 * 布局：URL 与耗时/请求头这类"一眼要看到"的元信息全部摊在顶部，
 * 不藏进页签；下面只用两个页签切换请求体与响应体这两块长文本。
 */
function RawTraffic({ traffic }: { traffic: JevTrace }) {
  const [body, setBody] = useState<'request' | 'response'>('request');

  return (
    <div className="raw">
      <div className="raw-url">
        <span className={`raw-method ${traffic.failed ? 'bad' : 'ok'}`}>
          {traffic.method} {traffic.status || 'ERR'}
        </span>
        <code title={traffic.url}>{traffic.url}</code>
      </div>

      <div className="raw-meta-grid">
        <MetaItem label="总耗时" value={`${traffic.totalMs}ms`} highlight />
        <MetaItem label="首字节" value={`${traffic.ttfbMs}ms`} />
        <MetaItem
          label="重试"
          value={traffic.attempts > 1 ? `${traffic.attempts - 1} 次` : '无'}
          tone={traffic.attempts > 1 ? 'warn' : undefined}
        />
        <MetaItem
          label="状态"
          value={String(traffic.status || 'ERR')}
          tone={traffic.failed ? 'bad' : 'ok'}
        />
      </div>

      <div className="raw-headers">
        <h5>请求头</h5>
        <pre className="raw-pre">
          {Object.entries(traffic.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')}
        </pre>
      </div>

      <div className="raw-tabs">
        <button
          className={body === 'request' ? 'active' : ''}
          onClick={() => setBody('request')}
        >
          请求体
        </button>
        <button
          className={body === 'response' ? 'active' : ''}
          onClick={() => setBody('response')}
        >
          响应体
        </button>
        {traffic.responseJson?.id && <span className="raw-reqid">{traffic.responseJson.id}</span>}
      </div>

      {body === 'request' ? (
        <JsonBlock text={traffic.requestBody} />
      ) : traffic.responseText ? (
        <JsonBlock text={traffic.responseText} />
      ) : (
        <p className="empty-hint">上游没有返回响应体</p>
      )}
    </div>
  );
}

function MetaItem({
  label,
  value,
  highlight,
  tone,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  return (
    <span className={`raw-meta-item ${highlight ? 'highlight' : ''} ${tone ?? ''}`}>
      <em>{label}</em>
      <b>{value}</b>
    </span>
  );
}

/**
 * JSON 正文块。
 *
 * 只做「标准化缩进 + 轻量着色」，保持 {} 与 [] 的原始结构：
 * 之前那版把每条键值拆成 DOM 行、颜色分得很重、还能逐项折叠，
 * 结果反而看不出 JSON 的层次，也不方便直接框选复制一段。
 * 现在就是一份标准的 2 空格缩进 JSON，读起来和终端里一样，
 * 只把字符串/数字/布尔做最轻的着色以便扫读。
 */
function JsonBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="raw-block">
      <div className="raw-block-head">
        <span className="raw-size">{formatSize(text)}</span>
        <button className="ghost-btn sm" onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="raw-pre">{highlightJson(prettyJson(text))}</pre>
    </div>
  );
}

/** 尽量按 2 空格缩进重排；原文不是合法 JSON 时原样展示，绝不吞掉内容 */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * 轻量语法着色。
 *
 * 用一个正则一次扫完，匹配顺序即优先级：字符串优先，
 * 因此 "键": 里的引号不会被当成结构符号处理，中文与转义引号也安全。
 * 只上三种颜色，避免把 JSON 本身的结构淹没在花花绿绿里。
 */
function highlightJson(text: string): React.ReactNode[] {
  const token = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = token.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));

    if (match[1] !== undefined) {
      // 后面跟着冒号即为键，否则是字符串值
      nodes.push(
        <span key={key++} className={match[2] ? 'j-key' : 'j-str'}>
          {match[1]}
        </span>,
      );
      if (match[2]) nodes.push(match[2]);
    } else if (match[3] !== undefined) {
      nodes.push(
        <span key={key++} className={match[3] === 'null' ? 'j-null' : 'j-bool'}>
          {match[3]}
        </span>,
      );
    } else {
      nodes.push(
        <span key={key++} className="j-num">
          {match[4]}
        </span>,
      );
    }

    last = token.lastIndex;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** 报文字节数：中文在 UTF-8 下占 3 字节，按字符数显示会明显偏小 */
function formatSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * 执行轨迹。
 *
 * 从纵向列表改成横向时间轴：动作名与状态都是短文本，横向排开更省高度，
 * 把腾出来的垂直空间让给上方的页签内容。执行顺序从左到右，
 * 因此默认滚到最右端，目光落点自然在最新的那一条。
 *
 * 它挂在右列页签之外，三个页签下都常驻——正在执行哪一串动作不该因为切页签而消失。
 */
export function ExecutionStrip({ events }: { events: TimelineEvent[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const lastId = events[events.length - 1]?.id;

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [lastId]);

  return (
    <div className="timeline-strip">
      <div className="timeline-strip-head">
        <h3>执行轨迹</h3>
        {events.length > 0 && <span className="counter">{events.length}</span>}
      </div>
      <div className="timeline-track" ref={ref}>
        {events.length === 0 && <span className="empty-hint">动作执行轨迹</span>}
        {events.map((ev) => (
          <span key={ev.id} className={`tl-chip ${ev.status}`} title={ev.actionId}>
            <span className="tl-dot" />
            <b>{ev.label}</b>
            <em>{STATUS_LABEL[ev.status]}</em>
          </span>
        ))}
      </div>
    </div>
  );
}
