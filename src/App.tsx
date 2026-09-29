import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatMessage, Emotion, ParamMap, ParamValue, RobotAction } from './domain/types';
import { SimulationEngine } from './engine/simulationEngine';
import type { EngineSnapshot } from './engine/simulationEngine';
import { loadConfig, sanitizeConfig } from './jev/config';
import type { JevConfig } from './jev/config';
import { JevDecisionProvider } from './jev/jevProvider';
import type { JevDecisionResult } from './jev/jevProvider';
import { buildJevRequest, defaultRobotContext, toRobotIntent } from './jev/robotQuestions';
import type { RobotContext } from './jev/robotQuestions';
import { mockJevEvaluate } from './jev/mockJev';
import { fetchProxyConfig, mergeProxyConfig } from './jev/proxyConfig';
import {
  planClarification,
  planFallback,
  planForIntent,
  planRefusal,
} from './jev/actionRouter';
import { ChatPanel } from './ui/ChatPanel';
import { ConfigPanel } from './ui/ConfigPanel';
import { RobotStage } from './ui/RobotStage';
import { TimelinePanel } from './ui/TimelinePanel';

let msgSeed = 0;
function nextMsgId(): string {
  msgSeed += 1;
  return `m${msgSeed}`;
}

type Tab = 'chat' | 'config';

export default function App() {
  // 引擎持有可变仿真状态，用惰性 state 保证整个生命周期只创建一次
  const [engine] = useState(() => new SimulationEngine());

  const [snapshot, setSnapshot] = useState<EngineSnapshot>(() => engine.getSnapshot());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [config, setConfig] = useState<JevConfig>(() => loadConfig());
  const [tab, setTab] = useState<Tab>('chat');
  const [deciding, setDeciding] = useState(false);
  /** 最近一次 Jev 判定的完整结果，供决策面板展示 */
  const [lastDecision, setLastDecision] = useState<JevDecisionResult | null>(null);

  const sanitized = useMemo(() => sanitizeConfig(config), [config]);

  /**
   * 启动时从本地代理拉取 .env 里的密钥/端点/模型。
   * 这样 .env 是唯一真源：填一次即可，浏览器不落盘也不需手工填写。
   * 检测到有效密钥后自动切到真实模式，省去手动切换。
   * 代理未启动时静默跳过，继续使用 localStorage 里的配置。
   */
  useEffect(() => {
    let cancelled = false;
    fetchProxyConfig().then((proxy) => {
      if (cancelled || !proxy || !proxy.hasKey) return;
      setConfig((prev) => ({ ...mergeProxyConfig(prev, proxy), mode: 'remote' }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 真实模式的 Provider；Mock 模式走离线路由，共享同一套判定策略 */
  const provider = useMemo(() => {
    if (sanitized.mode !== 'remote') return null;
    return new JevDecisionProvider({
      client: {
        endpoint: sanitized.endpoint,
        apiKey: sanitized.apiKey,
        timeoutMs: sanitized.timeoutMs,
        maxRetries: sanitized.maxRetries,
        useProxy: sanitized.proxyManaged,
      },
      policy: sanitized.policy,
      model: sanitized.model,
    });
  }, [sanitized]);

  useEffect(() => engine.subscribe(setSnapshot), [engine]);

  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      engine.tick(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const busy = deciding || snapshot.busy;

  /** 组装传给 Jev 的机器人上下文 */
  const buildContext = useCallback(
    (utterance: string, history: ChatMessage[]): RobotContext =>
      defaultRobotContext({
        pose: snapshot.pose,
        battery: snapshot.battery,
        busy: snapshot.busy,
        phase: snapshot.phase,
        currentActionId: snapshot.currentActionId,
        history,
        utterance,
        userDistanceCm: sanitized.userDistanceCm,
        environment: sanitized.environment,
        hardware: sanitized.hardware,
        safety: sanitized.safety,
      }),
    [sanitized, snapshot],
  );

  /** 把判定结果翻译成机器人动作与对话消息 */
  const applyDecision = useCallback(
    (result: JevDecisionResult) => {
      if (result.actions.length > 0) engine.enqueue(result.actions);
      setLastDecision(result);
      setMessages((prev) => [
        ...prev,
        {
          id: nextMsgId(),
          role: 'robot',
          content: result.utterance,
          emotion: result.emotion as Emotion,
          actionIds: result.actions.map((a) => a.actionId),
          choices: result.choices,
          reasoning: result.trace.join(' / '),
          latencyMs: result.latencyMs,
          timestamp: Date.now(),
        },
      ]);
    },
    [engine],
  );

  const handleSend = useCallback(
    async (text: string, choiceId?: string) => {
      if (deciding) return;

      const userMsg: ChatMessage = {
        id: nextMsgId(),
        role: 'user',
        content: text,
        timestamp: Date.now(),
        source: choiceId ? 'choice' : 'user',
      };
      const history = [...messages, userMsg];
      setMessages((prev) => [...prev, userMsg]);
      setDeciding(true);

      const ctx = buildContext(text, history);

      try {
        if (provider) {
          applyDecision(await provider.decide(ctx));
        } else {
          // Mock 模式：构造与 Jev 同形状的响应，再走同一套判定策略
          const request = buildJevRequest(ctx);
          const response = mockJevEvaluate(request);
          const policy = sanitized.policy;

          const intentRaw = response.answers.intent;
          const safetyRaw = response.answers.safe_to_execute;
          const clarifyRaw = response.answers.needs_clarification;
          const emotionRaw = response.answers.emotion;
          const urgencyRaw = response.answers.response_urgency;

          const intentKey = toRobotIntent(
            intentRaw?.type === 'choice' ? intentRaw.choice : 'unknown',
          );
          const confidence = intentRaw?.type === 'choice' ? intentRaw.confidence : 0;
          const safeNoul = safetyRaw?.type === 'noul' ? safetyRaw.noul : 1;
          const clarifyNoul = clarifyRaw?.type === 'noul' ? clarifyRaw.noul : 0;
          const emotionKey =
            emotionRaw?.type === 'choice' ? emotionRaw.choice : 'neutral';

          const planCtx = {
            battery: ctx.battery,
            busy: ctx.busy,
            hardware: ctx.hardware,
            holdingObject: false,
          };

          const trace: string[] = [`模型 ${response.model} (Mock)`];
          let plan: ReturnType<typeof planForIntent>;
          let executed = true;

          if (clarifyNoul >= policy.clarificationThreshold) {
            trace.push('路径：信息不足，先反问');
            plan = planClarification();
          } else if (safeNoul < policy.safetyThreshold) {
            trace.push('路径：安全闸门拦截');
            plan = planRefusal(intentKey, planCtx);
            executed = false;
          } else if (confidence < policy.reviewThreshold) {
            trace.push('路径：置信度过低，按未知意图处理');
            plan = planForIntent('unknown', emotionKey, planCtx);
          } else if (confidence < policy.autoActThreshold) {
            trace.push('路径：置信度中等，反问确认');
            plan = planClarification();
          } else {
            trace.push(`路径：直接执行 ${intentKey}`);
            plan = planForIntent(intentKey, emotionKey, planCtx);
          }

          trace.push(
            `intent conf=${confidence.toFixed(2)} safe noul=${safeNoul.toFixed(2)} clarify noul=${clarifyNoul.toFixed(2)}`,
          );

          applyDecision({
            utterance: plan.utterance,
            intent: intentKey,
            emotion: emotionKey,
            executed,
            actions: plan.actions,
            choices: plan.choices,
            raw: {
              intent: intentRaw?.type === 'choice' ? intentRaw : undefined,
              safeToExecute: safetyRaw?.type === 'noul' ? safetyRaw : undefined,
              urgency: urgencyRaw?.type === 'score' ? urgencyRaw : undefined,
              needsClarification: clarifyRaw?.type === 'noul' ? clarifyRaw : undefined,
              emotion: emotionRaw?.type === 'choice' ? emotionRaw : undefined,
            },
            trace,
            mode: 'jev',
            usage: {
              inputTokens: response.usage?.input_tokens ?? 0,
              outputTokens: response.usage?.output_tokens ?? 0,
            },
            latencyMs: 0,
            model: response.model,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const plan = planFallback();
        applyDecision({
          utterance: plan.utterance,
          intent: 'unknown',
          emotion: 'confused',
          executed: true,
          actions: plan.actions,
          choices: plan.choices,
          raw: {},
          trace: [`决策异常：${message}`],
          mode: 'fallback',
          latencyMs: 0,
          error: message,
        });
      } finally {
        setDeciding(false);
      }
    },
    [applyDecision, buildContext, deciding, messages, provider, sanitized.policy],
  );

  const handlePreviewAction = useCallback(
    (action: RobotAction) => {
      // 用动作默认值直接播放，绕过决策层
      const params: ParamMap = {};
      for (const p of action.params) {
        if (p.default !== undefined) params[p.name] = p.default as ParamValue;
      }
      engine.enqueue([{ actionId: action.id, params }]);
    },
    [engine],
  );

  const handleAbort = useCallback(() => engine.abortAll(), [engine]);

  const handleReset = useCallback(() => {
    engine.reset();
    setMessages([]);
    setDeciding(false);
    setLastDecision(null);
  }, [engine]);

  const providerLabel =
    sanitized.mode === 'remote'
      ? (provider?.label ?? 'Jev 连接中…')
      : `Jev Mock 模拟 · ${sanitized.model}`;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">JEV</span>
          <div>
            <h1>Jev 机器人指令台</h1>
            <p>语音 → Jev 决策（choice / noul / score）→ 动作编排</p>
          </div>
        </div>
        <div className="provider-badge" title="当前决策后端">
          <span className="dot" />
          {providerLabel}
        </div>
      </header>

      <main className="layout">
        <div className="stage-col">
          <RobotStage snapshot={snapshot} />
        </div>

        <aside className="side-col">
          <nav className="tabs">
            <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
              对话
            </button>
            <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>
              Jev 配置
            </button>
          </nav>

          {tab === 'chat' ? (
            <ChatPanel
              messages={messages}
              busy={busy}
              showReasoning={sanitized.showDebug}
              onSend={handleSend}
              onAbort={handleAbort}
              onReset={handleReset}
            />
          ) : (
            <ConfigPanel
              key={`${sanitized.mode}-${sanitized.model}-${sanitized.endpoint}`}
              config={sanitized}
              onChange={setConfig}
            />
          )}
        </aside>

        <div className="timeline-col">
          <TimelinePanel
            timeline={snapshot.timeline}
            onPreview={handlePreviewAction}
            decision={lastDecision}
          />
        </div>
      </main>
    </div>
  );
}
