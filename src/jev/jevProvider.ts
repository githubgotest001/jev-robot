import type { PlannedAction, QuickChoice } from '../domain/types';
import { filterActions, planClarification, planFallback, planForIntent, planRefusal } from './actionRouter';
import type { PlanContext } from './actionRouter';
import { JevClient, JevError } from './jevClient';
import type { JevClientConfig } from './jevClient';
import { QUESTION_IDS, buildJevRequest, toRobotIntent } from './robotQuestions';
import type { RobotContext, RobotIntent } from './robotQuestions';
import { asChoiceAnswer, asNoulAnswer, asScoreAnswer } from './jevTypes';
import type { JevChoiceAnswer, JevScoreAnswer } from './jevTypes';

export type DecisionMode = 'jev' | 'fallback';

/**
 * 决策阈值策略。
 *
 * Jev 的 confidence 反映分布集中度而非正确性，
 * 阈值必须由应用按自身风险自定。这里给出三档：
 * - >= autoActThreshold：直接执行
 * - >= reviewThreshold：先反问确认
 * - 低于 reviewThreshold：按 unknown 处理并给引导选项
 */
export interface DecisionPolicy {
  autoActThreshold: number;
  reviewThreshold: number;
  /** safe_to_execute 的 noul 低于此值则判定为不安全 */
  safetyThreshold: number;
  /** needs_clarification 的 noul 高于此值则先反问 */
  clarificationThreshold: number;
}

export const DEFAULT_POLICY: DecisionPolicy = {
  autoActThreshold: 0.7,
  reviewThreshold: 0.45,
  safetyThreshold: 0.6,
  clarificationThreshold: 0.65,
};

/** 决策结果：动作编排 + Jev 的原始判定，供 UI 展示 */
export interface JevDecisionResult {
  utterance: string;
  intent: RobotIntent;
  emotion: string;
  /** 是否实际执行了动作编排 */
  executed: boolean;
  actions: PlannedAction[];
  choices: QuickChoice[];
  raw: {
    intent?: JevChoiceAnswer;
    safeToExecute?: { noul: number };
    urgency?: JevScoreAnswer;
    needsClarification?: { noul: number };
    emotion?: JevChoiceAnswer;
  };
  /** 决策路径说明 */
  trace: string[];
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
    return `Jev ${this.model}`;
  }

  async decide(ctx: RobotContext): Promise<JevDecisionResult> {
    const started = performance.now();
    const trace: string[] = [];

    const request = buildJevRequest(ctx);
    request.model = this.model;

    try {
      const response = await this.client.evaluate(request);
      const latencyMs = Math.round(performance.now() - started);
      const answers = response.answers;

      const intentAnswer = asChoiceAnswer(answers[QUESTION_IDS.intent]);
      const safetyAnswer = asNoulAnswer(answers[QUESTION_IDS.safeToExecute]);
      const urgencyAnswer = asScoreAnswer(answers[QUESTION_IDS.responseUrgency]);
      const clarifyAnswer = asNoulAnswer(answers[QUESTION_IDS.needsClarification]);
      const emotionAnswer = asChoiceAnswer(answers[QUESTION_IDS.emotion]);

      trace.push(`模型 ${response.model}`);

      const intent = this.resolveIntent(intentAnswer);
      trace.push(`意图 ${intent} · confidence ${(intentAnswer?.confidence ?? 0).toFixed(2)}`);

      const emotion = this.resolveEmotion(emotionAnswer, intent);
      const urgency = urgencyAnswer?.score ?? 1;
      trace.push(`情绪 ${emotion} · 紧急度 ${urgency.toFixed(2)}`);

      const planCtx: PlanContext = {
        battery: ctx.battery,
        busy: ctx.busy,
        hardware: ctx.hardware,
        holdingObject: false,
      };

      const confidence = intentAnswer?.confidence ?? 0;
      const safeToExecute = safetyAnswer?.noul ?? 1;
      const needsClarification = clarifyAnswer?.noul ?? 0;
      trace.push(`安全 noul=${safeToExecute.toFixed(2)} · 需澄清 noul=${needsClarification.toFixed(2)}`);

      let plan: { utterance: string; actions: PlannedAction[]; choices: QuickChoice[] };
      let executed = true;

      if (needsClarification >= this.policy.clarificationThreshold) {
        trace.push('路径：信息不足，先反问');
        plan = planClarification();
      } else if (safeToExecute < this.policy.safetyThreshold) {
        trace.push('路径：安全闸门拦截');
        plan = planRefusal(intent, planCtx);
        executed = false;
      } else if (confidence < this.policy.reviewThreshold) {
        trace.push('路径：置信度过低，按未知意图处理');
        plan = planForIntent('unknown', emotion, planCtx);
      } else if (confidence < this.policy.autoActThreshold) {
        trace.push('路径：置信度中等，反问确认');
        plan = planClarification();
      } else {
        trace.push(`路径：直接执行 ${intent}`);
        plan = planForIntent(intent, emotion, planCtx);
      }

      const actions = plan.actions.length > 0 ? plan.actions : filterActions([], planCtx);

      return {
        utterance: plan.utterance,
        intent,
        emotion,
        executed,
        actions,
        choices: plan.choices,
        raw: {
          intent: intentAnswer ?? undefined,
          safeToExecute: safetyAnswer ?? undefined,
          urgency: urgencyAnswer ?? undefined,
          needsClarification: clarifyAnswer ?? undefined,
          emotion: emotionAnswer ?? undefined,
        },
        trace,
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
        err instanceof JevError ? `${err.message} (HTTP ${err.status})` : String(err);
      trace.push(`Jev 调用失败，降级到本地规则：${message}`);
      const plan = planFallback();
      return {
        utterance: plan.utterance,
        intent: 'unknown',
        emotion: 'confused',
        executed: true,
        actions: plan.actions,
        choices: plan.choices,
        raw: {},
        trace,
        mode: 'fallback',
        latencyMs: Math.round(performance.now() - started),
        error: message,
      };
    }
  }

  /** 把 Jev 返回的 choice 收敛到受支持的意图枚举 */
  private resolveIntent(answer: JevChoiceAnswer | null): RobotIntent {
    if (answer?.choice && toRobotIntent(answer.choice) !== 'unknown') {
      return answer.choice as RobotIntent;
    }
    if (answer?.probabilities) {
      const best = Object.entries(answer.probabilities)
        .filter(([k]) => toRobotIntent(k) !== 'unknown')
        .sort((a, b) => b[1] - a[1])[0];
      if (best) return best[0] as RobotIntent;
    }
    return 'unknown';
  }

  private resolveEmotion(answer: JevChoiceAnswer | null, intent: RobotIntent): string {
    const key = answer?.choice;
    const valid = ['neutral', 'happy', 'excited', 'curious', 'confused', 'sad', 'angry', 'sleepy', 'focus'];
    if (key && valid.includes(key)) return key;
    const FALLBACK: Partial<Record<RobotIntent, string>> = {
      greet: 'happy',
      goodbye: 'sad',
      stop: 'neutral',
      joke: 'excited',
      dance: 'excited',
      sleep: 'sleepy',
      unknown: 'confused',
      think: 'focus',
    };
    return FALLBACK[intent] ?? 'neutral';
  }
}