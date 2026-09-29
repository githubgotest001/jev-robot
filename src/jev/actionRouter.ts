import type { PlannedAction, QuickChoice } from '../domain/types';
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

/** 各风格对应的时长缩放：gentle 收敛、lively 放大 */
const STYLE_SCALE: Record<GestureStyle, number> = {
  gentle: 0.8,
  normal: 1,
  lively: 1.15,
  solemn: 0.9,
};

/** 风格对应的表情增强：lively 更生动，gentle 更柔和 */
const STYLE_EMOTION: Record<GestureStyle, string | null> = {
  gentle: null,
  normal: null,
  lively: 'excited',
  solemn: null,
};

/** 按风格缩放编排中所有动作的时长 */
function applyStyle(
  actions: PlannedAction[],
  style: GestureStyle,
): PlannedAction[] {
  const scale = STYLE_SCALE[style];
  if (scale === 1) return actions;
  return actions.map((a) => ({
    ...a,
    durationScale: (a.durationScale ?? 1) * scale,
  }));
}

interface IntentPlan {
  /** 机器人回复话术。Jev 不生成文本，话术来自这里。 */
  utterance: string;
  actions: (ctx: PlanContext) => PlannedAction[];
  choices: (ctx: PlanContext) => QuickChoice[];
  /** 该意图需要的硬件能力，缺失时会被安全闸门拦下 */
  requires?: Array<keyof PlanContext['hardware']>;
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
    utterance: '你好呀，我在呢！',
    actions: () => [
      emotionAction('happy'),
      { actionId: 'head.nod', params: { times: 2 } },
      { actionId: 'arm.wave', params: { times: 3, hand: 'right' }, durationScale: 0.9 },
    ],
    choices: () => [
      choice('g1', '你叫什么', '你叫什么名字'),
      choice('g2', '陪我一会', '陪我待一会儿'),
      choice('g3', '讲个笑话', '给我讲个笑话'),
    ],
  },
  goodbye: {
    utterance: '拜拜，记得想我哦！',
    actions: () => [
      emotionAction('sad'),
      { actionId: 'arm.wave', params: { times: 3, hand: 'left' } },
      { actionId: 'head.nod', params: { times: 1 } },
    ],
    choices: () => [
      choice('b1', '等我一下', '等一下我'),
      choice('b2', '再聊聊', '我们再聊一会儿'),
    ],
  },
  affirm: {
    utterance: '好嘞，交给我吧！',
    actions: () => [
      emotionAction('happy'),
      { actionId: 'head.nod', params: { times: 2 } },
      { actionId: 'arm.thumbs_up', params: { holdMs: 900 } },
    ],
    choices: () => [choice('a1', '继续', '继续吧'), choice('a2', '换个话题', '说点别的')],
  },
  deny: {
    utterance: '好，听你的。',
    actions: () => [emotionAction('neutral'), { actionId: 'head.shake', params: { times: 2 } }],
    choices: () => [choice('d1', '那就做', '那就还是做吧'), choice('d2', '再想想', '让我再想想')],
  },
  stop: {
    utterance: '好的，我停下了。',
    actions: () => [{ actionId: 'base.stop' }],
    choices: () => [
      choice('s1', '继续刚才', '继续刚才的动作'),
      choice('s2', '回到原位', '回到原来的位置'),
    ],
  },
  come_here: {
    utterance: '来啦来啦！',
    actions: () => [
      emotionAction('excited'),
      { actionId: 'head.look_at', params: { yaw: 0, pitch: 0 } },
      { actionId: 'base.move', params: { direction: 'forward', distanceCm: 40 } },
    ],
    choices: () => [choice('c1', '再近点', '再过来一点'), choice('c2', '回去', '回到原来的位置')],
  },
  go_back: {
    utterance: '我回原位啦。',
    actions: () => [
      emotionAction('neutral'),
      { actionId: 'base.return_home' },
      { actionId: 'head.reset' },
    ],
    choices: () => [choice('h1', '跟上我', '跟上我'), choice('h2', '原地待命', '在原地待机')],
  },
  rotate: {
    utterance: '好的，我转过去看看。',
    actions: () => [
      emotionAction('curious'),
      { actionId: 'base.rotate', params: { direction: 'left', angleDeg: 90 } },
      { actionId: 'head.tilt', params: { direction: 'left' } },
    ],
    choices: () => [choice('r1', '那边是什么', '那边有什么'), choice('r2', '转回来', '转回来看着我')],
  },
  fetch: {
    utterance: '给你！接好了。',
    actions: () => [
      emotionAction('happy'),
      { actionId: 'arm.pick', params: { force: 0.7 } },
      { actionId: 'arm.give', params: { holdMs: 800 } },
      { actionId: 'head.nod', params: { times: 1 } },
    ],
    choices: () => [choice('f1', '再来一个', '再帮我拿一个'), choice('f2', '放下', '把它放下')],
    requires: ['arm'],
  },
  put_down: {
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
    utterance: '我看一眼哦。',
    actions: () => [
      emotionAction('curious'),
      { actionId: 'head.look_at', params: { yaw: 45, pitch: 10 } },
      { actionId: 'screen.blink', params: { times: 2 } },
    ],
    choices: () => [choice('l1', '看到什么', '你看到什么了'), choice('l2', '看我', '看着我')],
  },
  thank: {
    utterance: '不客气，这是我该做的！',
    actions: () => [
      emotionAction('happy'),
      { actionId: 'head.nod', params: { times: 2 } },
      { actionId: 'arm.bow', params: { depth: 20 } },
      { actionId: 'audio.laugh' },
    ],
    choices: () => [choice('t1', '你真棒', '你真棒'), choice('t2', '再帮个忙', '再帮我一个忙')],
  },
  praise: {
    utterance: '嘿嘿，被夸了有点不好意思！',
    actions: () => [
      emotionAction('excited'),
      { actionId: 'arm.cover_face', params: { holdMs: 700 } },
      { actionId: 'audio.laugh' },
    ],
    choices: () => [
      choice('pr1', '夸夸自己', '你觉得自己怎么样'),
      choice('pr2', '继续干活', '继续帮我做事'),
    ],
  },
  joke: {
    utterance: '好的，听好了：为什么机器人从不迷路？因为它们有 GPS 呀！',
    actions: () => [
      emotionAction('excited'),
      { actionId: 'arm.dance', params: { intensity: 0.7 } },
      { actionId: 'audio.laugh' },
    ],
    choices: () => [choice('j1', '再来一个', '再讲一个'), choice('j2', '不好笑', '一点都不好笑')],
    requires: ['speaker'],
  },
  encourage: {
    utterance: '我陪着你呢，一起加油！',
    actions: () => [emotionAction('excited'), { actionId: 'arm.pump_fist', params: { times: 3 } }],
    choices: () => [choice('e1', '抱抱我', '抱抱我'), choice('e2', '陪我一会', '陪我待一会儿')],
  },
  hug: {
    utterance: '抱一个～',
    actions: () => [
      emotionAction('happy'),
      { actionId: 'arm.present', params: {} },
      { actionId: 'arm.cover_face', params: { holdMs: 600 } },
    ],
    choices: () => [choice('u1', '最爱你', '我最喜欢你了'), choice('u2', '陪我玩', '陪我玩会儿')],
  },
  dance: {
    utterance: '看我的！',
    actions: () => [emotionAction('excited'), { actionId: 'arm.dance', params: { intensity: 0.9 } }],
    choices: () => [choice('n1', '再跳一次', '再跳一次'), choice('n2', '唱首歌', '给我唱首歌')],
  },
  sing: {
    utterance: '啦啦啦～我唱得还行吧？',
    actions: () => [
      emotionAction('happy'),
      { actionId: 'screen.set_expression', params: { expression: 'joy', holdMs: 2500 } },
      { actionId: 'head.nod', params: { times: 2 } },
    ],
    choices: () => [choice('sg1', '再唱一首', '再唱一首'), choice('sg2', '跳个舞', '给我跳个舞')],
    requires: ['speaker'],
  },
  sleep: {
    utterance: '那我先眯一会儿，晚安～',
    actions: () => [emotionAction('sleepy'), { actionId: 'body.sleep' }],
    choices: () => [choice('w1', '叫醒你', '醒醒'), choice('w2', '我也睡了', '我也去睡了')],
  },
  wake: {
    utterance: '我醒啦！',
    actions: () => [
      emotionAction('excited'),
      { actionId: 'body.wake' },
      { actionId: 'screen.blink', params: { times: 2 } },
    ],
    choices: () => [choice('k1', '早', '早上好'), choice('k2', '继续睡', '再睡会儿')],
  },
  take_photo: {
    utterance: '好，看这边，笑一个～',
    actions: () => [
      emotionAction('happy'),
      { actionId: 'arm.present', params: {} },
      { actionId: 'screen.set_expression', params: { expression: 'joy', holdMs: 2500 } },
    ],
    choices: () => [choice('ph1', '再拍一张', '再拍一张'), choice('ph2', '给我看看', '给我看看照片')],
    requires: ['camera'],
  },
  follow: {
    utterance: '我来跟着你！',
    actions: () => [
      emotionAction('happy'),
      { actionId: 'head.look_at', params: { yaw: 0, pitch: 0 } },
      { actionId: 'base.move', params: { direction: 'forward', distanceCm: 25 } },
      { actionId: 'body.idle_breathe', params: { cycles: 1 } },
    ],
    choices: () => [choice('fo1', '停下', '停下'), choice('fo2', '回到原位', '回到原来的位置')],
    requires: ['mobility'],
  },
  play: {
    utterance: '好耶，陪你玩！',
    actions: () => [
      emotionAction('excited'),
      { actionId: 'head.tilt', params: { direction: 'right' } },
      { actionId: 'screen.blink', params: { times: 2 } },
    ],
    choices: () => [choice('pl1', '玩什么', '我们玩什么'), choice('pl2', '跳个舞', '给我跳个舞')],
  },
  ask_capability: {
    utterance: '我是 JEV-One，你的桌面伙伴！挥手、跳舞、指路、抓东西，我都能做。',
    actions: () => [
      emotionAction('happy'),
      { actionId: 'arm.present', params: {} },
      { actionId: 'head.nod', params: { times: 1 } },
    ],
    choices: () => [
      choice('i1', '跳个舞', '给我跳个舞'),
      choice('i2', '抓个东西', '帮我拿个东西'),
      choice('i3', '转个圈', '转个圈给我看'),
    ],
  },
  bored: {
    utterance: '有点无聊呢，我们找点事做吧？',
    actions: () => [
      emotionAction('sleepy'),
      { actionId: 'arm.shrug', params: { holdMs: 700 } },
      { actionId: 'head.tilt', params: { direction: 'right' } },
    ],
    choices: () => [
      choice('v1', '讲笑话', '给我讲个笑话'),
      choice('v2', '陪我玩', '陪我玩会儿'),
      choice('v3', '跳个舞', '给我跳个舞'),
    ],
  },
  think: {
    utterance: '让我想想……',
    actions: () => [
      emotionAction('focus'),
      { actionId: 'screen.set_expression', params: { expression: 'loading', holdMs: 2000 } },
      { actionId: 'head.look_at', params: { yaw: -35, pitch: -15 } },
      { actionId: 'arm.scratch_head' },
    ],
    choices: () => [choice('q1', '想到没', '想出来了吗'), choice('q2', '换个思路', '换个思路试试')],
  },
  smalltalk: {
    utterance: '嗯嗯，我在听。',
    actions: () => [
      emotionAction('neutral'),
      { actionId: 'head.nod', params: { times: 1 } },
      { actionId: 'body.idle_breathe', params: { cycles: 1 } },
    ],
    choices: () => [choice('st1', '你会什么', '你都能做些什么'), choice('st2', '陪我一会', '陪我待一会儿')],
  },
  unknown: {
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

/**
 * 根据意图与上下文生成完整的动作编排。
 * Jev 只给出 intent 和概率，具体编排完全由代码决定。
 */
export function planForIntent(
  intent: RobotIntent,
  emotion: string,
  ctx: PlanContext,
): { utterance: string; actions: PlannedAction[]; choices: QuickChoice[] } {
  const plan = PLANS[intent] ?? PLANS.unknown;
  const rawActions = plan.actions(ctx);
  // 编排里已显式指定表情时尊重编排，否则按推导出的情绪补一个
  const hasExplicitExpr = rawActions.some((a) => a.actionId === 'screen.set_expression');
  const filtered = filterActions(rawActions, ctx);
  const withEmotion = hasExplicitExpr
    ? filtered
    : [emotionAction(emotion), ...filtered];

  // lively 风格额外补一个更生动的表情
  const styleEmotion = STYLE_EMOTION[ctx.style];
  const withStyle =
    styleEmotion && !hasExplicitExpr
      ? [emotionAction(styleEmotion), ...withEmotion]
      : withEmotion;

  return {
    utterance: plan.utterance,
    actions: applyStyle(withStyle, ctx.style),
    choices: plan.choices(ctx),
  };
}

/** 安全闸门拦截时的编排：只做拒绝表情，不执行主动作 */
export function planRefusal(
  intent: RobotIntent,
  ctx: PlanContext,
): { utterance: string; actions: PlannedAction[]; choices: QuickChoice[] } {
  const plan = PLANS[intent] ?? PLANS.unknown;
  const missing = (['mobility', 'arm', 'speaker', 'camera'] as const).filter(
    (k) => plan.requires?.includes(k) && !ctx.hardware[k],
  );

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
