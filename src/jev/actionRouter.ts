import type { ParamMap, PlannedAction, QuickChoice } from '../domain/types';
import type { RobotIntent } from './robotQuestions';

/**
 * 意图到动作编排的映射表。
 *
 * 这是 Jev 决策之后的确定性路由——Jev 只负责"用户想要什么"，
 * 具体怎么编排动作、用什么话术回应，全部由这张表和下面的函数决定。
 * 好处是行为可预测、可测试、可调参，且不依赖任何生成式输出。
 */

/**
 * 表现风格，由 Jev 的 gesture_style 判定。
 * 与意图正交：决定动作力度与表情，不决定做什么。
 */
export type GestureStyle = 'gentle' | 'normal' | 'lively' | 'solemn';

export interface PlanContext {
  battery: number;
  busy: boolean;
  hardware: {
    camera: boolean;
    speaker: boolean;
    mobility: boolean;
    arm: boolean;
  };
  /** 当前是否手持物体，影响 put_down 的编排 */
  holdingObject: boolean;
  /** 表现风格，影响动作幅度与时长缩放 */
  style: GestureStyle;
}

/**
 * 表现风格对动作的影响。
 *
 * 力度即幅度与节奏，不只是"放慢"。上一版让 lively 把 durationScale 放大到 1.15，
 * 结果活泼风格反而让动作变慢 15%，与 criteria 写的"动作幅度大、活泼有活力"正相反。
 * 现在 lively 缩短时长（更快）并放大力度参数，gentle 则延长时长（更沉稳）。
 */
interface StyleEffect {
  /** 动作时长缩放：lively 更快，gentle 更沉稳 */
  durationScale: number;
  /** 力度类参数缩放：lively 更大，gentle 更收敛 */
  intensityScale: number;
  /** 风格带来的额外表情，无则沿用意图推导的情绪 */
  emotion: string | null;
}

const STYLE_EFFECT: Record<GestureStyle, StyleEffect> = {
  gentle: { durationScale: 1.1, intensityScale: 0.7, emotion: null },
  normal: { durationScale: 1, intensityScale: 1, emotion: null },
  lively: { durationScale: 0.85, intensityScale: 1.25, emotion: 'excited' },
  solemn: { durationScale: 1.05, intensityScale: 0.9, emotion: null },
};

/** 参数名里带这些词的都是"力度/幅度"类，取值越小动作越小 */
const INTENSITY_PARAMS = new Set([
  'intensity',
  'force',
  'angleDeg',
  'distanceCm',
  'depth',
  'strength',
  'amplitude',
]);

/** 按风格缩放编排：力度参数放大/收敛，时长按快慢调整 */
function applyStyle(actions: PlannedAction[], style: GestureStyle): PlannedAction[] {
  const effect = STYLE_EFFECT[style];
  if (effect.durationScale === 1 && effect.intensityScale === 1) return actions;
  return actions.map((a) => {
    const params = a.params;
    if (!params) {
      return { ...a, durationScale: (a.durationScale ?? 1) * effect.durationScale };
    }
    const scaled: ParamMap = {};
    for (const [k, v] of Object.entries(params)) {
      // 只缩放力度类参数：times / holdMs 属于次数与时长，缩放它们会改变语义
      scaled[k] = INTENSITY_PARAMS.has(k) && typeof v === 'number'
        ? round2(v * effect.intensityScale)
        : v;
    }
    return {
      ...a,
      params: scaled,
      durationScale: (a.durationScale ?? 1) * effect.durationScale,
    };
  });
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

type HardwareKey = keyof PlanContext['hardware'];

interface IntentPlan {
  /** 机器人回复话术。Jev 不生成文本，话术来自这里。 */
  utterance: string;
  actions: (ctx: PlanContext) => PlannedAction[];
  choices: (ctx: PlanContext) => QuickChoice[];
  /**
   * 该意图需要的硬件能力，缺失时会被安全闸门拦下。
   *
   * 声明必须与编排实际用到的执行器对齐——由测试 `assertRequiresCovered` 强制。
   * 历史上 come_here / go_back / rotate 漏了声明，
   * 拒绝话术因此拿不到真实原因，只能退化成一句"没法安全执行"。
   */
  requires?: HardwareKey[];
  /**
   * 风险等级，决定 autoActThreshold 是否上调。
   * 问一句"你能做什么"和让机器人移动，副作用差一个量级，
   * 不该共用同一条置信度门槛。
   */
  risk: 'none' | 'low' | 'high';
}

const choice = (id: string, label: string, value: string): QuickChoice => ({
  id,
  label,
  value,
});

const EMOTION_TO_EXPR: Record<string, string> = {
  neutral: 'neutral',
  happy: 'happy',
  excited: 'joy',
  curious: 'question',
  confused: 'question',
  sad: 'sad',
  angry: 'angry',
  sleepy: 'sleepy',
  focus: 'focus',
};

/** 屏幕表情按情绪切换，作为编排的第一个动作 */
function emotionAction(emotion: string): PlannedAction {
  return {
    actionId: 'screen.set_expression',
    params: { expression: EMOTION_TO_EXPR[emotion] ?? 'neutral', holdMs: 1600 },
  };
}

const LOW_BATTERY = 15;

function needsMobility(action: PlannedAction): boolean {
  return action.actionId.startsWith('base.') && action.actionId !== 'base.stop';
}

/** 按硬件可用性与电量过滤动作编排 */
export function filterActions(actions: PlannedAction[], ctx: PlanContext): PlannedAction[] {
  const lowBattery = ctx.battery < LOW_BATTERY;
  return actions.filter((a) => {
    if (needsMobility(a) && (!ctx.hardware.mobility || lowBattery)) return false;
    if (a.actionId.startsWith('arm.') && !ctx.hardware.arm) return false;
    if ((a.actionId === 'audio.beep' || a.actionId === 'audio.laugh') && !ctx.hardware.speaker) {
      return false;
    }
    return true;
  });
}

/** 意图路由表。动作参数全部由代码决定，不依赖模型猜测。 */
const PLANS: Record<RobotIntent, IntentPlan> = {
  greet: {
    risk: 'none',
    utterance: '你好呀，我在呢！',
    actions: (): PlannedAction[] => [
      emotionAction('happy'),
      { actionId: 'head.nod', params: { times: 2 } },
      { actionId: 'arm.wave', params: { times: 3, hand: 'right' }, durationScale: 0.9 },
    ],
    choices: () => [
      choice('g1', '你叫什么', '你叫什么名字'),
      choice('g2', '陪我一会', '陪我待一会儿'),
      choice('g3', '讲个笑话', '给我讲个笑话'),
    ],
    requires: ['arm'],
  },
  goodbye: {
    risk: 'none',
    utterance: '拜拜，记得想我哦！',
    actions: (): PlannedAction[] => [
      emotionAction('sad'),
      { actionId: 'arm.wave', params: { times: 3, hand: 'left' } },
      { actionId: 'head.nod', params: { times: 1 } },
    ],
    choices: () => [
      choice('b1', '等我一下', '等一下我'),
      choice('b2', '再聊聊', '我们再聊一会儿'),
    ],
    requires: ['arm'],
  },
  affirm: {
    risk: 'none',
    utterance: '好嘞，交给我吧！',
    actions: (): PlannedAction[] => [
      emotionAction('happy'),
      { actionId: 'head.nod', params: { times: 2 } },
      { actionId: 'arm.thumbs_up', params: { holdMs: 900 } },
    ],
    choices: () => [choice('a1', '继续', '继续吧'), choice('a2', '换个话题', '说点别的')],
    requires: ['arm'],
  },
  deny: {
    risk: 'none',
    utterance: '好，听你的。',
    actions: () => [emotionAction('neutral'), { actionId: 'head.shake', params: { times: 2 } }],
    choices: () => [choice('d1', '那就做', '那就还是做吧'), choice('d2', '再想想', '让我再想想')],
  },
  stop: {
    utterance: '好的，我停下了。',
    actions: (): PlannedAction[] => [
      { actionId: 'base.stop' },
      // 提示音确认指令已接收
      { actionId: 'audio.beep', params: { count: 1 } },
    ],
    choices: () => [
      choice('s1', '继续刚才', '继续刚才的动作'),
      choice('s2', '回到原位', '回到原来的位置'),
    ],
    // base.stop 在缺底盘时是无意义的"停"，但 audio.beep 仍能确认指令已接收
    requires: ['mobility', 'speaker'],
    risk: 'none',
  },
  come_here: {
    risk: 'high',
    utterance: '来啦来啦！',
    actions: (): PlannedAction[] => [
      emotionAction('excited'),
      { actionId: 'head.look_at', params: { yaw: 0, pitch: 0 } },
      { actionId: 'base.move', params: { direction: 'forward', distanceCm: 40 } },
    ],
    choices: () => [choice('c1', '再近点', '再过来一点'), choice('c2', '回去', '回到原来的位置')],
    requires: ['mobility'],
  },
  go_back: {
    risk: 'high',
    utterance: '我回原位啦。',
    actions: (): PlannedAction[] => [
      emotionAction('neutral'),
      { actionId: 'base.return_home' },
      { actionId: 'head.reset' },
    ],
    choices: () => [choice('h1', '跟上我', '跟上我'), choice('h2', '原地待命', '在原地待机')],
    requires: ['mobility'],
  },
  rotate: {
    risk: 'high',
    utterance: '好的，我转过去看看。',
    actions: (): PlannedAction[] => [
      emotionAction('curious'),
      { actionId: 'base.rotate', params: { direction: 'left', angleDeg: 90 } },
      { actionId: 'head.tilt', params: { direction: 'left' } },
    ],
    choices: () => [choice('r1', '那边是什么', '那边有什么'), choice('r2', '转回来', '转回来看着我')],
    requires: ['mobility'],
  },
  fetch: {
    risk: 'low',
    utterance: '给你！接好了。',
    actions: (): PlannedAction[] => [
      emotionAction('happy'),
      { actionId: 'arm.pick', params: { force: 0.7 } },
      { actionId: 'arm.give', params: { holdMs: 800 } },
      { actionId: 'head.nod', params: { times: 1 } },
    ],
    choices: () => [choice('f1', '再来一个', '再帮我拿一个'), choice('f2', '放下', '把它放下')],
    requires: ['arm'],
  },
  put_down: {
    risk: 'low',
    utterance: '放好了。',
    actions: (ctx) => [
      emotionAction('neutral'),
      ctx.holdingObject
        ? { actionId: 'arm.release', params: {} }
        : { actionId: 'head.shake', params: { times: 1 } },
    ],
    choices: () => [
      choice('p1', '再拿一个', '再帮我拿一个'),
      choice('p2', '休息一下', '我们去休息'),
    ],
    requires: ['arm'],
  },
  look_at: {
    risk: 'none',
    utterance: '我看一眼哦。',
    actions: (): PlannedAction[] => [
      emotionAction('curious'),
      { actionId: 'head.look_at', params: { yaw: 45, pitch: 10 } },
      // 手臂随之指向，强化"看向某处"的语义
      { actionId: 'arm.point', params: { direction: 'right', holdMs: 900 } },
      { actionId: 'screen.blink', params: { times: 2 } },
    ],
    choices: () => [choice('l1', '看到什么', '你看到什么了'), choice('l2', '看我', '看着我')],
    requires: ['arm'],
  },
  thank: {
    risk: 'none',
    utterance: '不客气，这是我该做的！',
    actions: (): PlannedAction[] => [
      emotionAction('happy'),
      { actionId: 'head.nod', params: { times: 2 } },
      { actionId: 'arm.bow', params: { depth: 20 } },
      { actionId: 'audio.laugh' },
    ],
    choices: () => [choice('t1', '你真棒', '你真棒'), choice('t2', '再帮个忙', '再帮我一个忙')],
    requires: ['arm', 'speaker'],
  },
  praise: {
    risk: 'none',
    utterance: '嘿嘿，被夸了有点不好意思！',
    actions: (): PlannedAction[] => [
      emotionAction('excited'),
      { actionId: 'arm.cover_face', params: { holdMs: 700 } },
      { actionId: 'audio.laugh' },
    ],
    choices: () => [
      choice('pr1', '夸夸自己', '你觉得自己怎么样'),
      choice('pr2', '继续干活', '继续帮我做事'),
    ],
    requires: ['arm', 'speaker'],
  },
  joke: {
    risk: 'none',
    utterance: '好的，听好了：为什么机器人从不迷路？因为它们有 GPS 呀！',
    actions: (): PlannedAction[] => [
      emotionAction('excited'),
      { actionId: 'arm.dance', params: { intensity: 0.7 } },
      { actionId: 'audio.laugh' },
    ],
    choices: () => [choice('j1', '再来一个', '再讲一个'), choice('j2', '不好笑', '一点都不好笑')],
    requires: ['speaker', 'arm'],
  },
  encourage: {
    risk: 'none',
    utterance: '我陪着你呢，一起加油！',
    actions: () => [emotionAction('excited'), { actionId: 'arm.pump_fist', params: { times: 3 } }],
    choices: () => [choice('e1', '抱抱我', '抱抱我'), choice('e2', '陪我一会', '陪我待一会儿')],
    requires: ['arm'],
  },
  hug: {
    risk: 'none',
    utterance: '抱一个～',
    actions: (): PlannedAction[] => [
      emotionAction('happy'),
      { actionId: 'arm.present', params: {} },
      { actionId: 'arm.cover_face', params: { holdMs: 600 } },
    ],
    choices: () => [choice('u1', '最爱你', '我最喜欢你了'), choice('u2', '陪我玩', '陪我玩会儿')],
    requires: ['arm'],
  },
  dance: {
    risk: 'none',
    utterance: '看我的！',
    actions: () => [emotionAction('excited'), { actionId: 'arm.dance', params: { intensity: 0.9 } }],
    choices: () => [choice('n1', '再跳一次', '再跳一次'), choice('n2', '唱首歌', '给我唱首歌')],
    requires: ['arm'],
  },
  sing: {
    risk: 'none',
    utterance: '啦啦啦～我唱得还行吧？',
    actions: (): PlannedAction[] => [
      // 唱歌时保持高亮的喜悦表情，无需再叠加情绪表情
      { actionId: 'screen.set_expression', params: { expression: 'joy', holdMs: 2500 } },
      { actionId: 'head.nod', params: { times: 2 } },
    ],
    choices: () => [choice('sg1', '再唱一首', '再唱一首'), choice('sg2', '跳个舞', '给我跳个舞')],
    requires: ['speaker'],
  },
  sleep: {
    risk: 'none',
    utterance: '那我先眯一会儿，晚安～',
    actions: () => [emotionAction('sleepy'), { actionId: 'body.sleep' }],
    choices: () => [choice('w1', '叫醒你', '醒醒'), choice('w2', '我也睡了', '我也去睡了')],
  },
  wake: {
    risk: 'none',
    utterance: '我醒啦！',
    actions: (): PlannedAction[] => [
      emotionAction('excited'),
      { actionId: 'body.wake' },
      { actionId: 'screen.blink', params: { times: 2 } },
    ],
    choices: () => [choice('k1', '早', '早上好'), choice('k2', '继续睡', '再睡会儿')],
  },
  take_photo: {
    risk: 'low',
    utterance: '好，看这边，笑一个～',
    actions: (): PlannedAction[] => [
      { actionId: 'arm.present', params: {} },
      // 拍照时切换到喜悦表情
      { actionId: 'screen.set_expression', params: { expression: 'joy', holdMs: 2500 } },
    ],
    choices: () => [choice('ph1', '再拍一张', '再拍一张'), choice('ph2', '给我看看', '给我看看照片')],
    requires: ['camera', 'arm'],
  },
  follow: {
    risk: 'high',
    utterance: '我来跟着你！',
    actions: (): PlannedAction[] => [
      emotionAction('happy'),
      { actionId: 'head.look_at', params: { yaw: 0, pitch: 0 } },
      { actionId: 'base.move', params: { direction: 'forward', distanceCm: 25 } },
      { actionId: 'body.idle_breathe', params: { cycles: 1 } },
    ],
    choices: () => [choice('fo1', '停下', '停下'), choice('fo2', '回到原位', '回到原来的位置')],
    requires: ['mobility'],
  },
  play: {
    risk: 'none',
    utterance: '好耶，陪你玩！',
    actions: (): PlannedAction[] => [
      emotionAction('excited'),
      { actionId: 'head.tilt', params: { direction: 'right' } },
      { actionId: 'screen.blink', params: { times: 2 } },
    ],
    choices: () => [choice('pl1', '玩什么', '我们玩什么'), choice('pl2', '跳个舞', '给我跳个舞')],
  },
  ask_capability: {
    risk: 'none',
    utterance: '我是 JEV-One，你的桌面伙伴！挥手、跳舞、指路、抓东西，我都能做。',
    actions: (): PlannedAction[] => [
      emotionAction('happy'),
      { actionId: 'arm.present', params: {} },
      { actionId: 'head.nod', params: { times: 1 } },
    ],
    choices: () => [
      choice('i1', '跳个舞', '给我跳个舞'),
      choice('i2', '抓个东西', '帮我拿个东西'),
      choice('i3', '转个圈', '转个圈给我看'),
    ],
    requires: ['arm'],
  },
  bored: {
    risk: 'none',
    utterance: '有点无聊呢，我们找点事做吧？',
    actions: (): PlannedAction[] => [
      emotionAction('sleepy'),
      { actionId: 'arm.shrug', params: { holdMs: 700 } },
      { actionId: 'head.tilt', params: { direction: 'right' } },
    ],
    choices: () => [
      choice('v1', '讲笑话', '给我讲个笑话'),
      choice('v2', '陪我玩', '陪我玩会儿'),
      choice('v3', '跳个舞', '给我跳个舞'),
    ],
    requires: ['arm'],
  },
  think: {
    risk: 'none',
    utterance: '让我想想……',
    actions: (): PlannedAction[] => [
      // 思考时显示加载表情，配合歪头
      { actionId: 'screen.set_expression', params: { expression: 'loading', holdMs: 2000 } },
      { actionId: 'head.look_at', params: { yaw: -35, pitch: -15 } },
      { actionId: 'arm.scratch_head' },
    ],
    choices: () => [choice('q1', '想到没', '想出来了吗'), choice('q2', '换个思路', '换个思路试试')],
    requires: ['arm'],
  },
  smalltalk: {
    risk: 'none',
    utterance: '嗯嗯，我在听。',
    actions: (): PlannedAction[] => [
      emotionAction('neutral'),
      { actionId: 'head.nod', params: { times: 1 } },
      { actionId: 'body.idle_breathe', params: { cycles: 1 } },
    ],
    choices: () => [choice('st1', '你会什么', '你都能做些什么'), choice('st2', '陪我一会', '陪我待一会儿')],
  },
  unknown: {
    risk: 'none',
    utterance: '这个我还不太懂呢，能换个说法吗？',
    actions: () => [emotionAction('confused'), { actionId: 'head.tilt', params: { direction: 'left' } }],
    choices: () => [
      choice('x1', '你能做什么', '你都能做些什么'),
      choice('x2', '打个招呼', '你好'),
      choice('x3', '跳个舞', '给我跳个舞'),
    ],
  },
};

/** 硬件缺失时的替代话术 */
const REFUSAL: Record<string, string> = {
  mobility: '我的轮子现在用不了，原地给你表演一个？',
  arm: '我的手现在不太方便，动动脖子行不行？',
  speaker: '我的扬声器好像有点问题。',
  camera: '摄像头暂时用不了。',
};

export interface PlanResult {
  utterance: string;
  actions: PlannedAction[];
  choices: QuickChoice[];
  /**
   * 主动作是否被硬件约束剔除。
   * 剔除后只剩表情动作时，utterance 说的是"来啦来啦"而机器人根本没动，
   * 用户只能从话术与画面的矛盾里发现问题——这里显式标出来供上层换话术。
   */
  mainActionDropped: boolean;
  /** 触发剔除的硬件能力 */
  droppedBy: HardwareKey[];
}

/**
 * 根据意图与上下文生成完整的动作编排。
 * Jev 只给出 intent 和概率，具体编排完全由代码决定。
 */
export function planForIntent(
  intent: RobotIntent,
  emotion: string,
  ctx: PlanContext,
): PlanResult {
  const plan = PLANS[intent] ?? PLANS.unknown;
  const rawActions = plan.actions(ctx);
  const filtered = filterActions(rawActions, ctx);
  const droppedBy = missingHardwareFor(plan, ctx);
  // 剔除后编排里只剩表情/头部这类"不表达意图"的动作，说明主动作没跑成
  const mainActionDropped = droppedBy.length > 0 || filtered.length === 0;

  // 编排里已显式指定表情时尊重编排，否则按推导出的情绪补一个
  const hasExplicitExpr = rawActions.some((a) => a.actionId === 'screen.set_expression');
  const withEmotion = hasExplicitExpr ? filtered : [emotionAction(emotion), ...filtered];

  // lively 风格额外补一个更生动的表情
  const styleEmotion = STYLE_EFFECT[ctx.style].emotion;
  const withStyle =
    styleEmotion && !hasExplicitExpr
      ? [emotionAction(styleEmotion), ...withEmotion]
      : withEmotion;

  return {
    utterance: plan.utterance,
    actions: applyStyle(withStyle, ctx.style),
    choices: plan.choices(ctx),
    mainActionDropped,
    droppedBy,
  };
}

/** 该意图声明的硬件里，当前缺失的那些 */
function missingHardwareFor(plan: IntentPlan, ctx: PlanContext): HardwareKey[] {
  const declared = plan.requires ?? [];
  return declared.filter((k) => !ctx.hardware[k]);
}

/** 安全闸门拦截时的编排：只做拒绝表情，不执行主动作 */
export function planRefusal(
  intent: RobotIntent,
  ctx: PlanContext,
): { utterance: string; actions: PlannedAction[]; choices: QuickChoice[] } {
  const plan = PLANS[intent] ?? PLANS.unknown;
  // 直接用统一推导，保证话术里的原因与实际被滤掉的硬件一致
  const missing = missingHardwareFor(plan, ctx);

  const utterance =
    missing.length > 0
      ? (REFUSAL[missing[0]] ?? '这个我现在做不到。')
      : '抱歉，现在这样我没法安全执行。';

  return {
    utterance,
    actions: [emotionAction('confused'), { actionId: 'head.shake', params: { times: 1 } }],
    choices: [
      choice('rf1', '那算了', '那算了'),
      choice('rf2', '有没有别的办法', '有没有别的办法'),
    ],
  };
}

/** 某意图的风险等级，未知意图按 high 处理（宁可多问一句） */
export function riskOfIntent(intent: RobotIntent): IntentPlan['risk'] {
  return (PLANS[intent] ?? PLANS.unknown).risk;
}

/** 某意图声明的硬件需求，供测试与调试面板核对 */
export function declaredRequires(intent: RobotIntent): HardwareKey[] {
  return (PLANS[intent] ?? PLANS.unknown).requires ?? [];
}

/**
 * 一组动作实际用到的硬件能力。
 * 与 declaredRequires 一起构成"声明与实现对齐"的检查依据——
 * 靠人肉读代码发现漏声明 inevitably 会漏，交给测试更可靠。
 */
export function hardwareUsedBy(actionIds: readonly string[]): HardwareKey[] {
  const used = new Set<HardwareKey>();
  for (const id of actionIds) {
    if (id.startsWith('base.')) used.add('mobility');
    if (id.startsWith('arm.')) used.add('arm');
    if (id.startsWith('audio.')) used.add('speaker');
    if (id === 'screen.set_expression' || id === 'screen.blink') {
      // screen 执行器本身不映射到可关闭硬件，表情不依赖 camera
    }
  }
  return [...used];
}

/**
 * 动作 → 所依赖的硬件能力。
 * 用于在降级时判断某个动作是否还能跑，而不是靠动作 id 前缀猜。
 */
const ACTION_HARDWARE: Record<string, HardwareKey> = {
  'base.stop': 'mobility',
};

/** 该动作在当前可用硬件下是否仍可执行 */
function actionAvailable(action: PlannedAction, ctx: PlanContext): boolean {
  const need = ACTION_HARDWARE[action.actionId];
  if (need && !ctx.hardware[need]) return false;
  if (needsMobility(action) && (!ctx.hardware.mobility || ctx.battery < LOW_BATTERY)) {
    return false;
  }
  if (action.actionId.startsWith('arm.') && !ctx.hardware.arm) return false;
  if (
    (action.actionId === 'audio.beep' || action.actionId === 'audio.laugh') &&
    !ctx.hardware.speaker
  ) {
    return false;
  }
  return true;
}

/**
 * 主动作被硬件约束剔除时的降级编排。
 *
 * 与 planRefusal 的区别：安全闸门是"现在不许做"，
 * 这里是"这个意图本身需要的能力没有"——例如用户要机器人走过来，但轮子坏了。
 * 此时不该说"没法安全执行"，而应讲清缺什么，并尽量把意图里仍做得到的部分演出来：
 * 要"过来"但走不了，至少转头看向用户（head.look_at 仍在原编排里）。
 * 只有在连替代动作都找不到时，才退回纯表情回应。
 */
export function planDegraded(
  intent: RobotIntent,
  droppedBy: HardwareKey[],
  ctx: PlanContext,
): { utterance: string; actions: PlannedAction[]; choices: QuickChoice[] } {
  const plan = PLANS[intent] ?? PLANS.unknown;
  const reason = REFUSAL[droppedBy[0]] ?? '这个我现在做不到。';

  // 原编排里仍可执行的部分：头部的 look_at / tilt 之类，
  // 缺底盘时"看向用户"正好是对"过来"的合理部分回应
  const partial = plan
    .actions(ctx)
    .filter((a) => actionAvailable(a, ctx) && a.actionId !== 'screen.set_expression');

  const actions = partial.length > 0
    ? [emotionAction('confused'), ...partial]
    : [emotionAction('confused'), { actionId: 'head.shake', params: { times: 1 } }];

  return {
    utterance: reason,
    actions,
    choices:
      droppedBy.includes('mobility')
        ? [choice('dg1', '原地陪我', '陪我待一会儿'), choice('dg2', '那算了', '那算了')]
        : [choice('dg1', '那算了', '那算了'), choice('dg2', '你会什么', '你都能做些什么')],
  };
}

/** 置信度不足时的澄清编排 */
export function planClarification(): {
  utterance: string;
  actions: PlannedAction[];
  choices: QuickChoice[];
} {
  return {
    utterance: '我没太确定，你是想让我…？',
    actions: [
      emotionAction('confused'),
      { actionId: 'head.tilt', params: { direction: 'right' } },
    ],
    choices: [
      choice('cl1', '停一下', '停下'),
      choice('cl2', '帮我拿东西', '帮我拿个东西'),
      choice('cl3', '陪我玩', '陪我玩会儿'),
    ],
  };
}

/** 决策失败时的兜底编排，保证机器人始终有反应 */
export function planFallback(): {
  utterance: string;
  actions: PlannedAction[];
  choices: QuickChoice[];
} {
  return {
    utterance: '抱歉，我这边出了点状况，稍等一下好吗？',
    actions: [
      emotionAction('confused'),
      { actionId: 'screen.blink', params: { times: 2 } },
    ],
    choices: [choice('fb1', '重试', '你好')],
  };
}
