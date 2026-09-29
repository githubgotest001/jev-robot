import type { PlannedAction, QuickChoice } from '../domain/types';
import { planClarification, planDegraded, planFallback, planForIntent, planRefusal, riskOfIntent } from './actionRouter';
import type { GestureStyle, PlanContext } from './actionRouter';
import { JevClient, JevError } from './jevClient';
import type { JevClientConfig, JevTransport } from './jevClient';
import { QUESTION_IDS, buildJevRequest, toRobotIntent } from './robotQuestions';
import type { RobotContext, RobotIntent } from './robotQuestions';
import { asChoiceAnswer, asNoulAnswer } from './jevTypes';
import type { JevAnswer, JevChoiceAnswer, JevRequest, JevResponse } from './jevTypes';

export type DecisionMode = 'jev' | 'fallback';

/** 决策走的哪条路径，供判定面板直接展示 */
export type DecisionPath =
  | 'direct'
  | 'ask'
  | 'unsure'
  | 'blocked'
  | 'undecided'
  | 'degraded'
  | 'fallback';

export const PATH_LABEL: Record<DecisionPath, string> = {
  direct: '直接执行',
  ask: '反问确认',
  unsure: '按未知意图处理',
  blocked: '安全闸门拦截',
  undecided: '安全判定摇摆，已反问',
  degraded: '硬件受限，已降级',
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
 *
 * safetyThreshold 是 noul 的放行线。noul 的特殊之处在于 0.5 表示"不知道"，
 * 因此它不是单边阈值而是一个区间，见 DecisionPolicy.safetyBand。
 */
export interface DecisionPolicy {
  autoActThreshold: number;
  reviewThreshold: number;
  /** safe_to_execute 的 noul 低于此值则判定为不安全 */
  safetyThreshold: number;
  /**
   * noul 的"不知道"区间，默认 [0.4, 0.6]。
   * 落在此区间说明模型在两个方向间摇摆，应当反问而不是硬选——
   * 直接按 safetyThreshold 一刀切会把"不确定安全"误当成"不安全"，
   * 表现为机器人无缘无故地拒绝合理请求。
   */
  safetyBand: [number, number];
  /**
   * 高风险意图上调后的执行门槛。
   * 会移动、会拿起东西的意图副作用更难回滚，应更保守。
   */
  highRiskAutoActThreshold: number;
}

export const DEFAULT_POLICY: DecisionPolicy = {
  autoActThreshold: 0.7,
  reviewThreshold: 0.45,
  safetyThreshold: 0.6,
  safetyBand: [0.4, 0.6],
  highRiskAutoActThreshold: 0.85,
};

export interface JevDecisionResult {
  utterance: string;
  intent: RobotIntent;
  emotion: string;
  /** Jev 判定的表现风格 */
  style: GestureStyle;
  /** 是否实际执行了动作编排 */
  executed: boolean;
  /**
   * 本次编排是否应抢占而非排队。
   * 停止类指令必须立刻打断正在执行的动作，不能排在队尾等前面播完。
   */
  preempt: boolean;
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

/**
 * 把 choice 非法时的概率分布重新收敛到受支持的意图。
 *
 * 上游给出不在枚举内的 choice 时不能直接沿用其 confidence——
 * 那个值是针对非法选项算出来的，与"合法候选里谁最像"是两回事。
 * 因此这里在合法子集上重新计算集中度。
 *
 * trustworthy 表示回收出的结果是否足以支撑直接执行：
 * 合法候选内高度集中说明模型其实判断明确，只是 choice 字段写了个枚举外的名字
 * （枚举漂移、上游版本不一致等），此时可以照常按门槛处理；
 * 候选内也平摊则说明确实拿不准，应当降级处理。
 */
function resolveIntentValue(
  choice: string | undefined,
  probabilities: Record<string, number> | undefined,
): { intent: RobotIntent; confidence: number | null; recovered: boolean; trustworthy: boolean } {
  if (choice && toRobotIntent(choice) !== 'unknown') {
    return { intent: choice as RobotIntent, confidence: null, recovered: false, trustworthy: true };
  }
  if (probabilities) {
    const legal = Object.entries(probabilities)
      .filter(([k]) => toRobotIntent(k) !== 'unknown')
      .sort((a, b) => b[1] - a[1]);
    const total = legal.reduce((s, [, p]) => s + (Number.isFinite(p) ? p : 0), 0);
    const top = legal[0];
    if (top && total > 0) {
      // 只看合法候选内部的集中度，与 choice 正常时的语义保持一致
      const topShare = Math.max(0, top[1]) / total;
      return { intent: top[0] as RobotIntent, confidence: topShare, recovered: true, trustworthy: topShare >= 0.7 };
    }
  }
  return { intent: 'unknown', confidence: null, recovered: true, trustworthy: false };
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
  /** 是否应抢占正在执行的动作（停止类指令） */
  preempt: boolean;
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

  const resolved = resolveIntentValue(intentAnswer?.choice, intentAnswer?.probabilities);
  const intent = resolved.intent;
  const confidence = resolved.confidence ?? intentAnswer?.confidence ?? 0;
  trace.push('意图 ' + intent + ' · confidence ' + confidence.toFixed(2));
  if (resolved.recovered) {
    trace.push('  原始 choice 不在受支持枚举内，已按合法候选的集中度重新评估');
  }

  const style = resolveStyleValue(styleAnswer?.choice);
  const emotion = emotionForIntent(intent, style);
  trace.push('风格 ' + style + ' · 情绪 ' + emotion);

  const safeToExecute = safetyAnswer?.noul ?? 1;
  trace.push('安全 noul=' + safeToExecute.toFixed(2));

  const planCtx: PlanContext = {
    battery: ctx.battery,
    busy: ctx.busy,
    hardware: ctx.hardware,
    // 持有物由夹爪开合度推断：夹爪收紧即认为手中有物
    holdingObject: ctx.pose.gripper > 0.5,
    style,
  };

  // 决策顺序：安全 > 置信度 > 执行
  // 不确定性由 intent 的 confidence 直接表达，无需独立问题
  const [bandLow, bandHigh] = policy.safetyBand;
  // 高风险意图（会移动、会取物）收紧执行门槛
  const risk = riskOfIntent(intent);
  const autoThreshold =
    risk === 'high' ? policy.highRiskAutoActThreshold : policy.autoActThreshold;
  const clarification = planClarification();

  let plan: { utterance: string; actions: PlannedAction[]; choices: QuickChoice[] };
  let executed = true;
  let path: DecisionPath;

  if (safeToExecute < bandLow) {
    path = 'blocked';
    trace.push('路径：安全闸门拦截');
    plan = planRefusal(intent, planCtx);
    executed = false;
  } else if (safeToExecute <= bandHigh) {
    /**
     * noul 落在摇摆区间：既不能算安全也不能算不安全。
     * 官方指出 noul ≈ 0.5 表示"不知道"，此时应当反问而非硬选——
     * 沿用旧的一刀切会把"不确定"误判成"不安全"，机器人会无缘无故拒绝合理请求。
     */
    path = 'undecided';
    trace.push('路径：noul 落在摇摆区间 [' + bandLow + ', ' + bandHigh + ']，判定为不确定，反问确认');
    plan = clarification;
    executed = false;
  } else if (confidence < policy.reviewThreshold || (resolved.recovered && !resolved.trustworthy)) {
    /**
     * 回收来的 intent 本身可信——合法候选内高度集中（0.89）说明模型其实很清楚，
     * 只是 choice 字段给了一个枚举外的名字。此时按正常门槛处理即可。
     * 只有候选内也不够集中时，回收结果才不足以支撑直接执行。
     */
    path = 'unsure';
    trace.push('路径：置信度过低，按未知意图处理');
    plan = planForIntent('unknown', emotion, planCtx);
  } else if (confidence < autoThreshold) {
    path = 'ask';
    trace.push(
      '路径：置信度中等，反问确认' + (risk === 'high' ? '（高风险意图，门槛 ' + autoThreshold + '）' : ''),
    );
    plan = clarification;
  } else {
    const intentPlan = planForIntent(intent, emotion, planCtx);
    if (intentPlan.mainActionDropped) {
      /**
       * 主动作被硬件约束剔除：话术在说"来啦"但机器人根本动不了。
       * 换用降级话术讲清缺什么，而不是让用户从话术与画面的矛盾里自己发现。
       */
      path = 'degraded';
      trace.push('路径：主动作被硬件约束剔除（' + intentPlan.droppedBy.join(',') + '），改用降级话术');
      plan = planDegraded(intent, intentPlan.droppedBy, planCtx);
      executed = false;
    } else {
      path = 'direct';
      trace.push('路径：直接执行 ' + intent);
      plan = intentPlan;
    }
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
    // 停止类指令抢占：清空队列并打断当前动作
    preempt: intent === 'stop',
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
        preempt: routed.preempt,
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
        preempt: false,
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
