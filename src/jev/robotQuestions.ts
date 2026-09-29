import { NEUTRAL_POSE, ROBOT_SPEC } from '../domain/robotSpec';
import type { ChatMessage, Pose } from '../domain/types';
import type {
  JevChoiceQuestion,
  JevNoulQuestion,
  JevRequest,
  JevScoreQuestion,
} from './jevTypes';

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

/** Jev 一次决策所问问题的 key，与响应 answers 的 key 一一对应 */
export const QUESTION_IDS = {
  intent: 'intent',
  safeToExecute: 'safe_to_execute',
  responseUrgency: 'response_urgency',
  needsClarification: 'needs_clarification',
  emotion: 'emotion',
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

/** 响应紧急度：Score，三档有序 */
export function buildUrgencyQuestion(): JevScoreQuestion {
  return {
    type: 'score',
    instructions:
      '根据 `user_speech` 判断机器人应以多快的速度作出反应。' +
      '用户语气急迫、要求立刻停止或涉及安全时为最高档；' +
      '普通请求为中档；闲聊、打发时间可以慢慢来。',
    criteria: [
      '可以稍后回应，例如闲聊、打发时间',
      '正常速度回应，例如普通请求',
      '立即回应，例如用户催促、要求立刻停止或涉及安全',
    ],
  };
}

/** 澄清需求：Noul，判断是否应先反问用户 */
export function buildClarificationQuestion(): JevNoulQuestion {
  return {
    type: 'noul',
    instructions:
      '判断当前信息是否足以确定用户意图。' +
      '若 `user_speech` 含糊、多义、缺少必要参数（如要看向哪个方向、要拿什么），' +
      '则答案为是——此时机器人应先反问确认，而不是直接执行。',
    criteria: {
      true: '信息不足或含糊，需要向用户反问确认',
      false: '信息充分，可以直接执行',
    },
  };
}

/** 情绪判定：Choice，用于选择表情与动作风格 */
export function buildEmotionQuestion(): JevChoiceQuestion {
  return {
    type: 'choice',
    instructions: '根据 `user_speech` 的语气和 `user_emotion`，判断机器人应以什么情绪回应。',
    criteria: {
      neutral: '中性、平静的日常回应',
      happy: '愉快、亲切的回应',
      excited: '兴奋、充满活力的回应',
      curious: '好奇、想了解更多的回应',
      confused: '困惑、不确定该如何理解',
      sad: '低落、安慰性的回应',
      angry: '生气或不满的回应',
      sleepy: '困倦、慢悠悠的回应',
      focus: '专注、认真执行的回应',
    },
  };
}

/** 组装完整请求：五个问题一次并行评估 */
export function buildJevRequest(ctx: RobotContext): JevRequest {
  return {
    model: 'typesafe/jev-1.13',
    state: buildState(ctx),
    questions: {
      [QUESTION_IDS.intent]: buildIntentQuestion(),
      [QUESTION_IDS.safeToExecute]: buildSafetyQuestion(),
      [QUESTION_IDS.responseUrgency]: buildUrgencyQuestion(),
      [QUESTION_IDS.needsClarification]: buildClarificationQuestion(),
      [QUESTION_IDS.emotion]: buildEmotionQuestion(),
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
