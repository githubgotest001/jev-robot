import type { PlannedAction, QuickChoice } from '../domain/types';
import { planClarification, planFallback, planForIntent, planRefusal } from './actionRouter';
import type { GestureStyle, PlanContext } from './actionRouter';
import { JevClient, JevError } from './jevClient';
import type { JevClientConfig, JevTransport } from './jevClient';
import { QUESTION_IDS, buildJevRequest, toRobotIntent } from './robotQuestions';
import type { RobotContext, RobotIntent } from './robotQuestions';
import { asChoiceAnswer, asNoulAnswer } from './jevTypes';
import type { JevAnswer, JevChoiceAnswer, JevRequest, JevResponse } from './jevTypes';

export type DecisionMode = 'jev' | 'fallback';

/** 决策走了哪条路径，供判定面板直接展示 */
export type DecisionPath = 'direct' | 'ask' | 'unsure' | 'blocked' | 'fallback';

export const PATH_LABEL: Record<DecisionPath, string> = {
  direct: '直接执行',
  ask: '反问确认',
  unsure: '按未知意图处理',
  blocked: '安全闸门拦截',
  fallback: '兜底编排',
};

/** 一次判定产生的原始数据，供「原始报文」视图展示 */
export interface JevTrace {
  /** 请求 URL */
  url: string;
  method: string;
  /** 实际发送的请求头（密钥脱敏） */
  headers: Record<string, string>;
  /** 请求体原文 */
  requestBody: string;
  /** 请求体解析结果，便于按键折叠查看；解析失败为 null */
  requestJson: JevRequest | null;
  /** HTTP 状态码，网络层失败为 0 */
  status: number;
  /** 响应体原文，未经加工 */
  responseText: string;
  /** 响应体解析结果 */
  responseJson: JevResponse | null;
  /** 总耗时，含重试与退避等待 */
  totalMs: number;
  /** 发出到收到响应头的耗时 */
  ttfbMs: number;
  /** 实际发起次数，>1 表示发生过重试 */
  attempts: number;
  /** 调用是否失败 */
  failed: boolean;
}

/**
 * 决策阈值策略。
 *
 * Jev 的 confidence 反映分布集中度而非正确性，
 * 阈值必须由应用按自身风险自定：
 * - >= autoActThreshold：直接执行
 * - >= reviewThreshold：先反问确认
 * - 低于 reviewThreshold：按 unknown 处理并给引导选项
 */
export interface DecisionPolicy {
  autoActThreshold: number;
  reviewThreshold: number;
  /** safe_to_execute 的 noul 低于此值则判定为不安全 */
  safetyThreshold: number;
}

export const DEFAULT_POLICY: DecisionPolicy = {
  autoActThreshold: 0.7,
  reviewThreshold: 0.45,
  safetyThreshold: 0.6,
};

export interface JevDecisionResult {
  utterance: string;
  intent: RobotIntent;
  emotion: string;
  /** Jev 判定的表现风格 */
  style: GestureStyle;
  /** 是否实际执行了动作编排 */
  executed: boolean;
  /** 决策走的分支：安全闸门 / 置信度过低 / 反问 / 直接执行 */
  path: DecisionPath;
  /** path 的中文说明 */
  pathLabel: string;
  actions: PlannedAction[];
  choices: QuickChoice[];
  raw: {
    intent?: JevChoiceAnswer;
    safeToExecute?: { noul: number };
    gestureStyle?: JevChoiceAnswer;
    /** score 类型问题的原始答案；本项目目前不提问，但协议支持，界面同样需要能渲染 */
    score?: { score: number; legend: string[]; probabilities: Record<string, number> };
  };
  /** 决策路径说明 */
  trace: string[];
  /** 本次调用的原始请求 / 响应 / 耗时；Mock 与降级路径同样会有 */
  traffic?: JevTrace;
  mode: DecisionMode;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  latencyMs: number;
  model?: string;
  error?: string;
}

export interface JevProviderOptions {
  client: JevClientConfig;
  policy?: Partial<DecisionPolicy>;
  model?: string;
}

// ─────────────────────── 纯函数：判定解析 ───────────────────────

/** 把 Jev 的 choice 收敛到受支持的意图枚举 */
function resolveIntentValue(
  choice: string | undefined,
  probabilities: Record<string, number> | undefined,
): RobotIntent {
  if (choice && toRobotIntent(choice) !== 'unknown') return choice as RobotIntent;
  if (probabilities) {
    const best = Object.entries(probabilities)
      .filter(([k]) => toRobotIntent(k) !== 'unknown')
      .sort((a, b) => b[1] - a[1])[0];
    if (best) return best[0] as RobotIntent;
  }
  return 'unknown';
}

/** 收敛表现风格，非法值回落 normal */
function resolveStyleValue(choice: string | undefined): GestureStyle {
  const valid: GestureStyle[] = ['gentle', 'normal', 'lively', 'solemn'];
  if (choice && (valid as string[]).includes(choice)) return choice as GestureStyle;
  return 'normal';
}

/**
 * 由意图与风格推导情绪。
 * 情绪不再向 Jev 单独提问——意图本身已隐含情绪倾向，
 * 风格只调节表现力度，不改变情绪本身。
 */
function emotionForIntent(intent: RobotIntent, style: GestureStyle): string {
  const base: Partial<Record<RobotIntent, string>> = {
    greet: 'happy',
    goodbye: 'sad',
    stop: 'neutral',
    deny: 'neutral',
    joke: 'excited',
    dance: 'joy',
    hug: 'happy',
    praise: 'excited',
    encourage: 'excited',
    wake: 'excited',
    sleep: 'sleepy',
    unknown: 'confused',
    think: 'focus',
    bored: 'sleepy',
  };
  const emotion = base[intent] ?? 'neutral';
  if (style === 'solemn' && (emotion === 'joy' || emotion === 'excited')) return 'happy';
  return emotion;
}

export interface RoutedDecision {
  plan: { utterance: string; actions: PlannedAction[]; choices: QuickChoice[] };
  intent: RobotIntent;
  emotion: string;
  style: GestureStyle;
  executed: boolean;
  path: DecisionPath;
  raw: JevDecisionResult['raw'];
}

/**
 * 把 Jev 的原始答案路由为动作编排——决策的核心。
 *
 * Mock 与真实模式共用这一份实现：传输方式不同，
 * 但从答案到动作的判定逻辑必须完全一致，
 * 否则 Mock 下调通的分支在真实模式下会失效。
 */
export function routeAnswers(
  answers: Record<string, JevAnswer>,
  ctx: RobotContext,
  policy: DecisionPolicy,
  trace: string[],
): RoutedDecision {
  const intentAnswer = asChoiceAnswer(answers[QUESTION_IDS.intent]);
  const safetyAnswer = asNoulAnswer(answers[QUESTION_IDS.safeToExecute]);
  const styleAnswer = asChoiceAnswer(answers[QUESTION_IDS.gestureStyle]);

  const intent = resolveIntentValue(intentAnswer?.choice, intentAnswer?.probabilities);
  const confidence = intentAnswer?.confidence ?? 0;
  trace.push('意图 ' + intent + ' · confidence ' + confidence.toFixed(2));

  const style = resolveStyleValue(styleAnswer?.choice);
  const emotion = emotionForIntent(intent, style);
  trace.push('风格 ' + style + ' · 情绪 ' + emotion);

  const safeToExecute = safetyAnswer?.noul ?? 1;
  trace.push('安全 noul=' + safeToExecute.toFixed(2));

  const planCtx: PlanContext = {
    battery: ctx.battery,
    busy: ctx.busy,
    hardware: ctx.hardware,
    // 持有物由夹爪开合度推断：夹爪收紧即认为手中���物
    holdingObject: ctx.pose.gripper > 0.5,
    style,
  };

  let plan: { utterance: string; actions: PlannedAction[]; choices: QuickChoice[] };
  let executed = true;
  let path: DecisionPath;

  // 决策顺序：安全 > 置信度 > 执行
  // 不确定性由 intent 的 confidence 直接表达，无需独立问题
  if (safeToExecute < policy.safetyThreshold) {
    path = 'blocked';
    trace.push('路径：安全闸门拦截');
    plan = planRefusal(intent, planCtx);
    executed = false;
  } else if (confidence < policy.reviewThreshold) {
    path = 'unsure';
    trace.push('路径：置信度过低，按未知意图处理');
    plan = planForIntent('unknown', emotion, planCtx);
  } else if (confidence < policy.autoActThreshold) {
    path = 'ask';
    trace.push('路径：置信度中等，反问确认');
    plan = planClarification();
  } else {
    path = 'direct';
    trace.push('路径：直接执行 ' + intent);
    plan = planForIntent(intent, emotion, planCtx);
  }

  /**
   * 最终兜底：编排为空时补一个保底动作。
   * 可能原因：意图对应的编排所需硬件全被过滤（如 fetch 但机械臂不可用）。
   * 此时机器人必须有反应，否则会表现为"指令被吞掉"。
   */
  if (plan.actions.length === 0) {
    path = 'fallback';
    trace.push('编排为空，追加保底动作');
    plan = { ...plan, actions: planFallback().actions };
  }

  return {
    plan,
    intent,
    emotion,
    style,
    executed,
    path,
    raw: {
      intent: intentAnswer ?? undefined,
      safeToExecute: safetyAnswer ?? undefined,
      gestureStyle: styleAnswer ?? undefined,
    },
  };
}

/**
 * Jev 决策 Provider。
 *
 * 与生成式 LLM 的根本区别：Jev 不产出任何文本，
 * 这里负责把它的定型答案翻译成动作编排与话术。
 */
export class JevDecisionProvider {
  private readonly client: JevClient;
  private readonly policy: DecisionPolicy;
  readonly model: string;

  constructor(options: JevProviderOptions) {
    this.client = new JevClient(options.client);
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    this.model = options.model ?? 'typesafe/jev-1.13';
  }

  get label(): string {
    return 'Jev ' + this.model;
  }

  async decide(ctx: RobotContext): Promise<JevDecisionResult> {
    const started = performance.now();
    const trace: string[] = [];

    const request = buildJevRequest(ctx);
    request.model = this.model;

    try {
      const { response, transport } = await this.client.evaluateDetailed(request);
      const latencyMs = Math.round(performance.now() - started);

      trace.push('模型 ' + response.model);
      const routed = routeAnswers(response.answers, ctx, this.policy, trace);

      return {
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
        traffic: toTrace(request, transport, false),
        mode: 'jev',
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          costUsd: response.usage?.cost ?? response.usage?.cost_usd,
        },
        latencyMs,
        model: response.model,
      };
    } catch (err) {
      const message =
        err instanceof JevError ? err.message + ' (HTTP ' + err.status + ')' : String(err);
      trace.push('Jev 调用失败，降级到本地规则：' + message);
      const plan = planFallback();
      /**
       * 失败时同样把请求留下：出错场景下"到底发了什么、上游回了什么"
       * 恰恰是最需要看的，只给一句错误信息等于把排查线索丢掉。
       */
      const failed = err instanceof JevError ? err.transport : undefined;
      return {
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
        trace,
        traffic: failed ? toTrace(request, failed, true) : undefined,
        mode: 'fallback',
        latencyMs: Math.round(performance.now() - started),
        error: message,
      };
    }
  }
}

/** 把传输细节与请求体整理成界面可直接渲染的结构 */
function toTrace(request: JevRequest, transport: JevTransport, failed: boolean): JevTrace {
  let responseJson: JevResponse | null = null;
  if (transport.responseText) {
    try {
      responseJson = JSON.parse(transport.responseText) as JevResponse;
    } catch {
      responseJson = null;
    }
  }
  return {
    url: transport.url,
    method: 'POST',
    headers: transport.headers,
    requestBody: transport.requestBody,
    requestJson: request,
    status: transport.status,
    responseText: transport.responseText,
    responseJson,
    totalMs: transport.totalMs,
    ttfbMs: transport.ttfbMs,
    attempts: transport.attempts,
    failed,
  };
}
