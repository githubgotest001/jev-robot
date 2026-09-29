/**
 * Jev API 协议类型定义。
 *
 * Jev 是 TypeSafe 的非生成式决策模型（System One model）：
 * 输入一个 state 加一组定型问题，输出 choice / score / noul 三种答案之一，
 * 每个答案附带校准概率。模型本身不产出任何文本。
 *
 * 参考：
 *   https://thejevai.com/docs
 *   https://openrouter.ai/blog/insights/what-is-jev/
 */

/** 问题类型：Jev 仅支持这三种 */
export type JevQuestionType = 'choice' | 'score' | 'noul';

/**
 * instructions 可为 string / object / array。
 * 当问题需要引用额外数据时，用对象并在其中按字段名反引号引用。
 */
export type JevInstructions = string | Record<string, unknown> | unknown[];

/** Choice 问题：从最多 255 个预定义选项中选一个 */
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: JevInstructions;
  /** 选项 key -> 含义描述。key 不会发给模型，语义必须写在描述里。 */
  criteria: Record<string, string | object | unknown[] | null>;
}

/** Score 问题：在 2~10 个有序档位上评分 */
export interface JevScoreQuestion {
  type: 'score';
  instructions: JevInstructions;
  /** 有序数组，由低到高。至少 2 档，最多 10 档。 */
  criteria: unknown[];
}

/** Noul 问题：判断某个命题成立的概率 */
export interface JevNoulQuestion {
  type: 'noul';
  instructions: JevInstructions;
  /** 可选，描述 true / false 的含义 */
  criteria?: { true: string | object | unknown[] | null; false: string | object | unknown[] | null };
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

/** Choice 答案 */
export interface JevChoiceAnswer {
  type: 'choice';
  /** 概率最高的选项 key */
  choice: string;
  /** 每个选项的概率，和为 1 */
  probabilities: Record<string, number>;
  /** 由分布集中度导出的确定度 0~1，不代表正确性 */
  confidence: number;
}

/** Score 答案 */
export interface JevScoreAnswer {
  type: 'score';
  /** 概率加权分值，可落在档位之间（如 1.66） */
  score: number;
  /** 档位序号 -> 描述 */
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

/** Noul 答案：只有概率本身，没有独立的 confidence 字段 */
export interface JevNoulAnswer {
  type: 'noul';
  /** 命题成立的概率 0~1 */
  noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

/** 请求体 */
export interface JevRequest {
  /** 形如 typesafe/jev-1.13 或 jev-latest */
  model: string;
  /** 待评估的内容：文本、JSON 对象或文本数组 */
  state: string | Record<string, unknown> | string[];
  /** 问题表，key 自定义，响应按同样的 key 返回 */
  questions: Record<string, JevQuestion>;
}

/** 响应体 */
export interface JevResponse {
  /** 实际服务本次请求的模型快照 */
  model: string;
  /** 与请求 questions 一一对应 */
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    /** 美元，部分网关返回 */
    cost?: number;
    cost_usd?: number;
  };
  id?: string;
  provider?: string;
}

/** 错误响应 */
export interface JevErrorResponse {
  error?: {
    message?: string;
    type?: string;
  };
  message?: string;
}

/** 把未知值收敛为 Choice 答案，字段缺失时给出安全默认 */
export function asChoiceAnswer(answer: JevAnswer | undefined): JevChoiceAnswer | null {
  if (!answer || answer.type !== 'choice') return null;
  const choice = typeof answer.choice === 'string' ? answer.choice : '';
  const probabilities =
    answer.probabilities && typeof answer.probabilities === 'object'
      ? answer.probabilities
      : {};
  return {
    type: 'choice',
    choice,
    probabilities,
    confidence: clamp01(answer.confidence),
  };
}

export function asScoreAnswer(answer: JevAnswer | undefined): JevScoreAnswer | null {
  if (!answer || answer.type !== 'score') return null;
  return {
    type: 'score',
    score: Number.isFinite(answer.score) ? answer.score : 0,
    legend: answer.legend ?? {},
    probabilities: answer.probabilities ?? {},
    confidence: clamp01(answer.confidence),
  };
}

export function asNoulAnswer(answer: JevAnswer | undefined): JevNoulAnswer | null {
  if (!answer || answer.type !== 'noul') return null;
  return { type: 'noul', noul: clamp01(answer.noul) };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}