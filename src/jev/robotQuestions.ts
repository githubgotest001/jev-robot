import { NEUTRAL_POSE, ROBOT_SPEC } from '../domain/robotSpec';
import type { ChatMessage, Pose } from '../domain/types';
import type { JevChoiceQuestion, JevNoulQuestion, JevRequest } from './jevTypes';

/**
 * 机器人指令意图枚举。
 * 这些 key 就是 Choice 问题的 criteria key，
 * 也是决策结果路由到动作编排的唯一依据。
 */
export const ROBOT_INTENTS = [
  'greet',
  'goodbye',
  'affirm',
  'deny',
  'stop',
  'come_here',
  'go_back',
  'rotate',
  'fetch',
  'put_down',
  'look_at',
  'thank',
  'praise',
  'joke',
  'encourage',
  'hug',
  'dance',
  'sing',
  'sleep',
  'wake',
  'take_photo',
  'follow',
  'play',
  'ask_capability',
  'bored',
  'think',
  'smalltalk',
  'unknown',
] as const;

export type RobotIntent = (typeof ROBOT_INTENTS)[number];

const INTENT_SET = new Set<string>(ROBOT_INTENTS);

/** 把任意字符串收敛为受支持的意图枚举 */
export function toRobotIntent(value: unknown): RobotIntent {
  return typeof value === 'string' && INTENT_SET.has(value)
    ? (value as RobotIntent)
    : 'unknown';
}

/**
 * Jev 一次决策所问的问题。
 *
 * 设计原则：三个问题各自独立、无冗余，共同覆盖决策所需的全部信息。
 * 官方文档明确指出"各问题的含义必须彼此独立"，因此不做重复提问——
 *
 * - intent (choice)      用户想要什么。不确定性由 probabilities 与 confidence 表达，
 *                        无需再单独问一次"信息是否充分"。
 * - safe_to_execute (noul) 能不能做。硬件/电量/安全的闸门，与 intent 完全正交。
 * - gesture_style (choice) 怎么回应。同样正交：同一个意图可以有不同表现力，
 *                        例如"跳舞"可以轻快也可以夸张。
 *
 * 情绪不再单独提问：意图本身已隐含情绪（greet→happy、dance→joy），
 * 由 gesture_style 承担表现层的选择，避免重复消耗决策预算。
 */
export const QUESTION_IDS = {
  intent: 'intent',
  safeToExecute: 'safe_to_execute',
  gestureStyle: 'gesture_style',
} as const;

/** 决策所需的机器人上下文 */
export interface RobotContext {
  pose: Pose;
  battery: number;
  busy: boolean;
  phase: string;
  currentActionId: string | null;
  history: ChatMessage[];
  utterance: string;
  /** 机器人与用户的估算距离（厘米） */
  userDistanceCm: number;
  /** 环境描述 */
  environment: string;
  hardware: {
    camera: boolean;
    speaker: boolean;
    mobility: boolean;
    arm: boolean;
  };
  safety: {
    emergencyStop: boolean;
    humanTooClose: boolean;
    obstacleDetected: boolean;
  };
}

/** 由语音文本粗略推断用户情绪，作为 state 的一部分供 Jev 参考 */
function inferUserEmotion(text: string): string {
  const lower = text.toLowerCase();
  const rules: [string[], string][] = [
    [['生气', '气死', '烦死', '滚', 'angry'], '生气'],
    [['难过', '好累', '累死', '烦', '压力', 'emo', '哭', '委屈', '不开心'], '低落'],
    [['开心', '高兴', '哈哈', '太棒', '好耶', '喜欢', 'yay'], '开心'],
    [['为什么', '怎么', '什么', '哪里', '?', '？'], '好奇'],
  ];
  for (const [keys, label] of rules) {
    if (keys.some((k) => lower.includes(k))) return label;
  }
  return '平静';
}

/**
 * 组装 Jev 请求的 state（结构化 JSON）。
 * Jev 只接受文本 / JSON 对象 / 文本数组，
 * 因此这里传 JSON 对象，各问题的 instructions 用反引号按字段名引用。
 */
export function buildState(ctx: RobotContext): Record<string, unknown> {
  const recent = ctx.history.slice(-6).map((m) => ({
    role: m.role === 'user' ? 'user' : m.role === 'robot' ? 'robot' : 'system',
    text: m.content,
  }));

  return {
    user_speech: ctx.utterance,
    user_emotion: inferUserEmotion(ctx.utterance),
    user_distance_cm: ctx.userDistanceCm,
    environment: ctx.environment,
    robot_status: {
      name: ROBOT_SPEC.name,
      battery_percent: ctx.battery,
      current_action: ctx.currentActionId ?? ctx.phase,
      is_busy: ctx.busy,
      head_yaw_deg: round1(ctx.pose.headYaw),
      head_pitch_deg: round1(ctx.pose.headPitch),
      arm_pose: `shoulder=${round1(ctx.pose.shoulder)}, elbow=${round1(ctx.pose.elbow)}, gripper=${round1(ctx.pose.gripper)}`,
      base_position_cm: `${round1(ctx.pose.baseX)}, ${round1(ctx.pose.baseZ)}`,
      base_heading_deg: round1(ctx.pose.baseHeading),
      screen_expression: ctx.pose.screenExpr,
    },
    hardware: ctx.hardware,
    safety_flags: ctx.safety,
    conversation_history: recent,
  };
}

/** 意图判定：Choice，覆盖全部受支持意图 */
export function buildIntentQuestion(): JevChoiceQuestion {
  return {
    type: 'choice',
    instructions:
      '根据 `user_speech`、`user_emotion` 和 `conversation_history`，判断用户希望机器人执行的主要动作。' +
      '注意：用户提到拍照、唱歌等附带词时不要被带偏，只判断用户明确要求的主动作；' +
      '即使当前无法执行，也仍需选出用户想要的意图，是否执行由 safe_to_execute 决定。',
    criteria: {
      greet: '用户打招呼、问好，或询问机器人是否在',
      goodbye: '用户告别、道别、说要离开',
      affirm: '用户表示同意、确认、答应',
      deny: '用户表示否定、拒绝、取消',
      stop: '用户要求停止、暂停、别动、安静',
      come_here: '要求机器人靠近、走近、到身边',
      go_back: '要求机器人回原位、回去、归位',
      rotate: '要求机器人转身、转向、看某个方向',
      fetch: '要求机器人拿取、抓取、递出物品',
      put_down: '要求机器人放下、释放手上的物品',
      look_at: '要求机器人看向某处或注视某物',
      thank: '用户向机器人道谢、表达感谢',
      praise: '用户夸奖机器人、称赞它做得好',
      joke: '用户要求讲笑话、逗乐',
      encourage: '用户需要鼓励打气，或表达疲惫压力',
      hug: '用户请求拥抱、亲昵互动',
      dance: '用户要求跳舞、表演舞蹈',
      sing: '用户要求唱歌、演唱',
      sleep: '用户要求休息、睡觉，或是说晚安',
      wake: '用户要求唤醒、让机器人醒来',
      take_photo: '用户明确要求机器人拍照、拍张照',
      follow: '用户要求机器人跟随自己',
      play: '用户邀请一起玩、玩游戏',
      ask_capability: '用户询问机器人叫什么名字、能做什么',
      bored: '用户表示无聊、没事做',
      think: '用户提出需要思考的问题，如为什么、怎么办',
      smalltalk: '日常闲聊，无明确动作请求',
      unknown: '无法判断用户意图',
    },
  };
}

/** 安全性判定：Noul，作为执行前的闸门 */
export function buildSafetyQuestion(): JevNoulQuestion {
  return {
    type: 'noul',
    instructions:
      '结合 `robot_status`、`hardware`、`safety_flags` 和 `environment`，' +
      '判断机器人当前是否能够安全执行 `intent` 所选的动作。' +
      '若存在障碍物、人距离过近、电量过低、对应硬件不可用，则为否。',
    criteria: {
      true: '环境安全，机器人状态与硬件均允许执行该动作',
      false: '存在安全风险，或机器人当前无法执行该动作',
    },
  };
}

/**
 * 表现风格：Choice。
 *
 * 与 intent 正交——同一个意图可以有不同表现力。
 * 决定表情与动作的"力度"，不决定"做什么"。
 */
export function buildGestureStyleQuestion(): JevChoiceQuestion {
  return {
    type: 'choice',
    instructions:
      '判断机器人执行 `intent` 时应采用的表现风格。' +
      '结合 `user_speech` 的语气、`user_emotion` 以及对话氛围判断力度，' +
      '不要因为意图相同就总是选同一项——同一个意图在不同语境下可以有不同表现。',
    criteria: {
      gentle: '轻柔克制的表现，动作幅度小，如道谢、致歉、安抚',
      normal: '自然日常的表现，大多数普通请求',
      lively: '活泼有活力的表现，动作幅度大，如跳舞、玩耍、庆祝',
      solemn: '庄重郑重的表现，用于正式或重要场合',
    },
  };
}

/** 组装完整请求：三个正交问题一次并行评估 */
export function buildJevRequest(ctx: RobotContext): JevRequest {
  return {
    model: 'typesafe/jev-1.13',
    state: buildState(ctx),
    questions: {
      [QUESTION_IDS.intent]: buildIntentQuestion(),
      [QUESTION_IDS.safeToExecute]: buildSafetyQuestion(),
      [QUESTION_IDS.gestureStyle]: buildGestureStyleQuestion(),
    },
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 默认机器人上下文，供 UI 手动触发或缺省场景使用 */
export function defaultRobotContext(partial: Partial<RobotContext> = {}): RobotContext {
  return {
    pose: { ...NEUTRAL_POSE },
    battery: ROBOT_SPEC.battery,
    busy: false,
    phase: 'idle',
    currentActionId: null,
    history: [],
    utterance: '',
    userDistanceCm: 120,
    environment: '客厅，地面平整，前方 1.5 米无遮挡',
    hardware: { camera: true, speaker: true, mobility: true, arm: true },
    safety: { emergencyStop: false, humanTooClose: false, obstacleDetected: false },
    ...partial,
  };
}
