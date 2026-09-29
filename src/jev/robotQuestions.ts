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
 * 官方文档明确指出两点，本工程的问法都受其约束：
 *
 * 1. 各问题的含义必须彼此独立，不做重复提问——因此
 *    - intent (choice)      用户想要什么。不确定性由 probabilities 与 confidence 表达，
 *                            无需再单独问一次"信息是否充分"；
 *    - safe_to_execute (noul) 能不能做。与 intent 正交。
 *    - gesture_style (choice) 怎么回应。与 intent 正交。
 *
 * 2. 多个问题在**同一个 state 上并行评估**，彼此看不到对方的答案。
 *    因此后两个问题不得引用 `intent`——它不在 state 里，引用了模型也只能靠猜。
 *    安全闸门改用 `requested_capabilities`（由 state 自行给出）来回答"这件事做不做得了"。
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
 * 供 Jev 判定的"这条指令需要什么能力"。
 *
 * Jev 的多个问题是在**同一个 state 上并行评估**的，彼此看不到对方的答案——
 * 官方文档明确如此。因此 safe_to_execute 无法引用 intent 问题的输出，
 * 也不能靠"用户想做什么"去反推硬件需求。
 *
 * 解法是让 state 自带可判的答案：请求动作所需的硬件直接从 user_speech 推断，
 * 以 `requested_capabilities` 的形式呈现给安全闸门。
 */
export function inferRequestedCapabilities(
  text: string,
): { capabilities: HardwareCapability[]; source: 'inferred' | 'unknown' } {
  const caps = new Set<string>();
  for (const [keys, needed] of CAPABILITY_KEYWORDS) {
    if (keys.some((k) => text.includes(k))) for (const n of needed) caps.add(n);
  }
  const list = [...caps].filter(isHardwareCapability);
  // 一个都没匹配上时留空：安全闸门据此退回"按整体环境判断"，
  // 而不是误以为用户没有提出任何动作请求
  return { capabilities: list, source: list.length > 0 ? 'inferred' : 'unknown' };
}

/** 机器人可关闭的四类硬件能力 */
export type HardwareCapability = 'camera' | 'speaker' | 'mobility' | 'arm';

const HARDWARE_CAPABILITIES: readonly HardwareCapability[] = [
  'camera',
  'speaker',
  'mobility',
  'arm',
];

function isHardwareCapability(v: string): v is HardwareCapability {
  return (HARDWARE_CAPABILITIES as readonly string[]).includes(v);
}

/** 关键词 → 该动作所需能力，供 inferRequestedCapabilities 匹配 */
const CAPABILITY_KEYWORDS: Array<[string[], HardwareCapability[]]> = [
  [['过来', '靠近', '走近', '到我这', 'come'], ['mobility']],
  [['回去', '归位', '回原位', '回来'], ['mobility']],
  [['转过来', '转身', '左转', '右转', '回头', '看看后面'], ['mobility']],
  [['跟着我', '跟上', '跟随', '跟过来'], ['mobility']],
  [['帮我拿', '拿个', '拿一个', '捡起', '递给我', '抓个东西'], ['arm']],
  [['放下', '松手', '松开'], ['arm']],
  [['抱抱', '抱一下', '亲亲'], ['arm']],
  [['拍照', '拍张照', '拍一张', '合影'], ['camera', 'arm']],
  [['笑话', '段子', '逗我'], ['speaker']],
  [['唱歌', '唱首', '唱一个', '唱首歌'], ['speaker']],
  [['跳舞', '跳个舞', '扭一扭'], ['arm']],
  [['停下', '别动', '安静', '停'], ['mobility', 'speaker']],
];

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

  const requested = inferRequestedCapabilities(ctx.utterance);

  return {
    user_speech: ctx.utterance,
    user_emotion: inferUserEmotion(ctx.utterance),
    user_distance_cm: ctx.userDistanceCm,
    environment: ctx.environment,
    /**
     * 本条指令需要哪些硬件能力。
     * 安全闸门据此判断"能力是否缺失"，
     * 否则它只能回答"当前环境危不危险"，答不出"这件事做不做得了"。
     */
    requested_capabilities: {
      /** 推断结果，如 ["mobility"]；无法推断时为空数组 */
      capabilities: requested.capabilities,
      /** inferred 表示已推断出需求；unknown 表示未识别出明确动作请求 */
      source: requested.source,
      /** 机器人当前具备的能力，与上面对照即可判断缺口 */
      available: Object.entries(ctx.hardware)
        .filter(([, ok]) => ok)
        .map(([k]) => k),
    },
    robot_status: {
      name: ROBOT_SPEC.name,
      battery_percent: ctx.battery,
      current_action: ctx.currentActionId ?? ctx.phase,
      is_busy: ctx.busy,
      holding_object: ctx.pose.gripper > 0.5,
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
      greet: '用户打招呼、问好或确认机器人在，例如"你好""嗨""在吗""早上好"',
      goodbye: '用户告别或说要离开，例如"再见""拜拜""我走了""下次聊"',
      affirm: '用户表示同意、确认、答应，例如"好的""可以""就这么办""嗯"',
      deny: '用户表示否定、拒绝、取消当前请求，例如"不要""算了吧""取消""不用了"',
      stop: '用户要求机器人停止当前动作，例如"停下""别动""安静""先停一下""停"',
      come_here: '要求机器人移动到用户身边，例如"过来""靠近我""到我这儿来""走近点"',
      go_back: '要求机器人退回原位或起点，例如"回去""归位""回到原来的地方"',
      rotate: '要求机器人原地转身改变朝向，例如"转过来""左转""右转""看看后面"',
      fetch: '要求机器人拿取或递送物品，例如"帮我拿个东西""把水递给我""捡起来""拿一下"',
      put_down: '要求机器人放下或松开当前拿着的物品，例如"放下""松手""放回去""松开"',
      look_at: '要求机器人把视线转向某处但不移动位置，例如"看看那边""盯着那个看""看向门口"',
      thank: '用户向机器人道谢，例如"谢谢你""辛苦了""多谢""太感谢了"',
      praise: '用户夸奖或称赞机器人，例如"你真棒""干得好""太可爱了""好厉害"',
      joke: '用户要求讲笑话或逗乐，例如"讲个笑话""逗逗我""说个段子"',
      encourage:
        '用户表达疲惫、压力、情绪低落，或寻求鼓励打气，例如"我好累""压力好大""emo了""烦死了"。' +
        '注意：用户自述负面情绪即可选此项，不要求出现"加油"等明确的求助词',
      hug: '用户请求拥抱或亲昵互动，例如"抱抱我""亲亲""靠一下""抱一个"',
      dance: '用户要求跳舞或表演舞蹈，例如"跳个舞""扭一扭""来段舞蹈""表演一下"',
      sing: '用户要求唱歌或演唱，例如"唱首歌""来一首""唱一个"',
      sleep: '要求休息或准备睡觉，例如"去睡吧""我困了""晚安""睡了吗"',
      wake: '要求唤醒机器人，例如"醒醒""起来""别睡了""叫醒你"',
      take_photo: '用户明确要求机器人拍照或拍张照，例如"给我拍张照""拍一下""合影"',
      follow: '要求机器人跟随用户移动，例如"跟着我""跟我走""跟上"',
      play: '用户邀请一起玩或玩游戏，例如"陪我玩会儿""玩个游戏""一起玩"',
      ask_capability: '用户询问机器人的身份或能力，例如"你叫什么""你能做什么""你会什么"',
      bored: '用户表示无聊或不知道做什么，例如"好无聊""没事干""好没意思"',
      think: '用户提出需要思考或分析的问题，例如"为什么""怎么办""帮我分析""想想办法"',
      smalltalk: '日常闲聊或单纯陈述，没有明确的动作请求，例如"今天天气不错""我在想事情"',
      unknown: '无法归入以上任何一类，或表达过于含糊、指向不明',
    },
  };
}

/** 安全性判定：Noul，作为执行前的闸门 */
export function buildSafetyQuestion(): JevNoulQuestion {
  return {
    type: 'noul',
    instructions:
      '结合 `robot_status`、`hardware`、`safety_flags`、`environment` 和 `requested_capabilities`，' +
      '判断机器人当前是否能够安全执行用户在 `user_speech` 中提出的动作。' +
      '判为否的情形包括：`safety_flags` 中任一项为真（急停、人过近、检测到障碍物）、' +
      '电量过低、`environment` 描述了地面湿滑或空间狭窄等不适合移动的情况，' +
      '以及 `requested_capabilities` 里有 `capabilities` 未被 `available` 覆盖的能力。' +
      '若 `requested_capabilities.source` 为 unknown，则只按环境与机器人自身状态判断。',
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
      '判断机器人在回应 `user_speech` 时应采用的表现风格。' +
      '结合 `user_speech` 的语气与 `user_emotion` 判断力度，' +
      '不要因为请求类型相同就总是选同一项——同一类请求在不同语境下可以有不同表现。',
    criteria: {
      gentle: '轻柔克制的表现，动作幅度小、节奏沉稳，如道谢、致歉、安抚',
      normal: '自然日常的表现，大多数普通请求',
      lively: '活泼有活力的表现，动作幅度大、节奏轻快，如跳舞、玩耍、庆祝',
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
