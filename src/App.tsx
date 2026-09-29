import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Emotion, ParamMap, ParamValue, RobotAction } from './domain/types';
import { SimulationEngine } from './engine/simulationEngine';
import type { EngineSnapshot } from './engine/simulationEngine';
import { loadConfig, sanitizeConfig, isProxyEndpoint } from './jev/config';
import type { JevConfig } from './jev/config';
import { JevDecisionProvider, PATH_LABEL, routeAnswers } from './jev/jevProvider';
import type { JevDecisionResult } from './jev/jevProvider';
import { buildJevRequest, defaultRobotContext } from './jev/robotQuestions';
import type { RobotContext } from './jev/robotQuestions';
import { mockJevEvaluate } from './jev/mockJev';
import { fetchProxyConfig, mergeProxyConfig } from './jev/proxyConfig';
import { planFallback } from './jev/actionRouter';
import { ChatPanel } from './ui/ChatPanel';
import { RightPanel } from './ui/RightPanel';
import type { RightTab } from './ui/RightPanelTabs';
import { RobotStage } from './ui/RobotStage';

let msgSeed = 0;
function nextMsgId(): string {
  msgSeed += 1;
  return `m${msgSeed}`;
}

export default function App() {
  // 引擎持有可变仿真状态，用惰性 state 保证整个生命周期只创建一次
  const [engine] = useState(() => new SimulationEngine());

  const [snapshot, setSnapshot] = useState<EngineSnapshot>(() => engine.getSnapshot());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [config, setConfig] = useState<JevConfig>(() => loadConfig());
  /** 右列初始页签可由 `?tab=library` / `?tab=config` 指定，便于直接分享某个视图 */
  const [rightTab, setRightTab] = useState<RightTab>(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    return wanted === 'library' || wanted === 'config' ? wanted : 'decision';
  });
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
        /**
         * 是否走代理由「当前端点」当场判定，不能读 proxyManaged 标志。
         *
         * proxyManaged 只是"配置曾经由代理下发"的历史痕迹：代理会把密钥清空
         * 并置为 true，之后用户把端点预设切成 OpenRouter，这个标志不会自己复位。
         * 一旦拿它当判据，请求就会既不带上密钥、又发往 OpenRouter，
         * 上游拿不到凭证只能回退到 cookie 鉴权，报 401 No cookie auth credentials found。
         */
        useProxy: isProxyEndpoint(sanitized.endpoint),
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
          // Mock 模式：本地构造与 Jev 同形状的响应，
          // 之后走与真实模式完全相同的 routeAnswers，保证分支一致
          const request = buildJevRequest(ctx);
          const response = mockJevEvaluate(request);
          const trace: string[] = [`模型 ${response.model} (Mock)`];
          const routed = routeAnswers(response.answers, ctx, sanitized.policy, trace);

          applyDecision({
            utterance: routed.plan.utterance,
            intent: routed.intent,
            emotion: routed.emotion,
            style: routed.style,
            executed: routed.executed,
            path: routed.path,
            pathLabel: PATH_LABEL[routed.path],
            actions: routed.plan.actions,
            choices: routed.plan.choices,
            raw: routed.raw,
            trace,
            /**
             * Mock 也给出完整的 traffic 结构，只是耗时标记为 0。
             * 这样「原始报文」视图在离线默认模式下同样可用——
             * 界面形状与真实模式保持一致，切到真机不会换一套逻辑。
             */
            traffic: {
              url: 'mock://jev/local',
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              requestBody: JSON.stringify(request, null, 2),
              requestJson: request,
              status: 200,
              responseText: JSON.stringify(response, null, 2),
              responseJson: response,
              totalMs: 0,
              ttfbMs: 0,
              attempts: 1,
              failed: false,
            },
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
          style: 'normal',
          executed: true,
          path: 'fallback',
          pathLabel: PATH_LABEL.fallback,
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

  /**
   * 演示入口：`?ask=给我跳个舞` 打开页面即自动发一次指令。
   * 这样某一次判定的完整概率分布可以直接分享 / 复现，
   * 截图与录屏也不必先手点一遍。（左列页签由 `?tab=` 在初始化时决定）
   */
  const firedDemo = useRef(false);
  const sendRef = useRef(handleSend);

  useEffect(() => {
    sendRef.current = handleSend;
  }, [handleSend]);

  useEffect(() => {
    if (firedDemo.current) return;
    firedDemo.current = true;
    const ask = new URLSearchParams(window.location.search).get('ask');
    if (ask) void sendRef.current(ask);
  }, []);

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

  /** 最近一次用户输入，用于在判定面板里回看"这次是拿什么判的" */
  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i].content;
    }
    return '';
  }, [messages]);

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
        {/*
          舞台独占左列、拿最大宽度：点动作库里的动作时，
          机器人画面必须一直看得见，所以动作库不能和它抢这一列。
        */}
        <div className="stage-col">
          <RobotStage snapshot={snapshot} />
        </div>

        <aside className="side-col">
          <ChatPanel
            messages={messages}
            busy={snapshot.busy}
            deciding={deciding}
            showReasoning={sanitized.showDebug}
            onSend={handleSend}
            onAbort={handleAbort}
            onReset={handleReset}
          />
        </aside>

        <div className="right-col">
          <RightPanel
            tab={rightTab}
            onTabChange={setRightTab}
            decision={lastDecision}
            policy={sanitized.policy}
            timeline={snapshot.timeline}
            onPreview={handlePreviewAction}
            currentActionId={snapshot.currentActionId}
            decisionTone={snapshot.busy ? 'var(--warn)' : 'var(--ok)'}
            config={sanitized}
            onConfigChange={setConfig}
            state={{
              utterance: lastUserText,
              userDistanceCm: sanitized.userDistanceCm,
              environment: sanitized.environment,
              battery: snapshot.battery,
              busy: snapshot.busy,
              currentActionId: snapshot.currentActionId,
              hardware: sanitized.hardware,
            }}
          />
        </div>
      </main>
    </div>
  );
}
