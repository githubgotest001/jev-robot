import { ROBOT_INTENTS } from './robotQuestions';
import type { RobotIntent } from './robotQuestions';
import type { JevAnswer, JevRequest, JevResponse } from './jevTypes';

/**
 * 离线 Jev 模拟器。
 *
 * 用规则近似 Jev 的输出形状，使整条链路（state → questions → answers
 * → 动作编排）无需联网、无需 API Key 即可跑通。
 * 它模拟的是**协议形状**，不是 Jev 的判断能力——
 * 置信度刻意给得比真实 Jev 低，用来验证低置信度分支。
 */

const KEYWORD_RULES: [string[], RobotIntent][] = [
  [['跳舞', '跳个舞', 'dance', '扭一扭'], 'dance'],
  [['唱歌', '唱首', '唱一首', 'sing'], 'sing'],
  [['拍照', '拍张照', '拍一张', 'photo'], 'take_photo'],
  [['跟随', '跟着我', '跟过来', 'follow'], 'follow'],
  [['笑话', '搞笑', '讲个', '逗我', 'joke'], 'joke'],
  [['停下', '别动', '站住', '安静', 'stop'], 'stop'],
  [['你好', 'hello', 'hi', '嗨', '早上好', '在吗', '嘿'], 'greet'],
  [['再见', '拜拜', 'bye', '我走了'], 'goodbye'],
  [['谢谢', '感谢', 'thanks', '辛苦了'], 'thank'],
  [['厉害', '真棒', '好棒', '可爱', '喜欢', '干得好'], 'praise'],
  [['加油', '你可以', '努力', '我好累', '烦', '压力', '鼓励'], 'encourage'],
  [['抱抱', '抱一下', 'hug', '亲亲'], 'hug'],
  [['一起玩', '陪我玩', '玩游戏'], 'play'],
  [['放下', '松手', '释放', 'put down'], 'put_down'],
  [['回来', '回去', '归位', '回位', '回原位'], 'go_back'],
  [['过来', '靠近', '走近', '到我这', 'come'], 'come_here'],
  [['转身', '转向', '转过去', '看那边', '回头', 'rotate', '左转', '右转'], 'rotate'],
  [['拿', '取', '捡', '给我', '递', '帮我拿'], 'fetch'],
  [['看', '看看', 'look'], 'look_at'],
  [['睡觉', '休息', '休眠', '晚安', 'sleep'], 'sleep'],
  [['醒醒', '唤醒', '起床', 'wake'], 'wake'],
  [['你叫什么', '你是谁', '介绍一下', '你会什么', '你能做什么'], 'ask_capability'],
  [['无聊', '没意思', '干嘛呢'], 'bored'],
  [['为什么', '怎么办', '怎么', '思考', '脑筋'], 'think'],
  [['好的', '好呀', '可以', '同意', '没错'], 'affirm'],
  [['不要', '不用', '别', '不对', '拒绝', '取消', '算了吧'], 'deny'],
];

const NEEDS_MOBILITY: RobotIntent[] = ['come_here', 'go_back', 'rotate', 'follow'];
const NEEDS_ARM: RobotIntent[] = ['fetch', 'put_down'];
const NEEDS_SPEAKER: RobotIntent[] = ['joke', 'sing'];
const NEEDS_CAMERA: RobotIntent[] = ['take_photo'];

const EMOTIONS = [
  'neutral',
  'happy',
  'excited',
  'curious',
  'confused',
  'sad',
  'angry',
  'sleepy',
  'focus',
];

function matchIntent(utterance: string): RobotIntent {
  const lower = utterance.toLowerCase();
  let best: { intent: RobotIntent; len: number } | null = null;
  for (const [keys, intent] of KEYWORD_RULES) {
    for (const k of keys) {
      if (lower.includes(k.toLowerCase()) && (!best || k.length > best.len)) {
        best = { intent, len: k.length };
      }
    }
  }
  return best?.intent ?? 'smalltalk';
}

function matchEmotion(text: string): string {
  const lower = text.toLowerCase();
  const rules: [string[], string][] = [
    [['生气', '气死', '烦死'], 'angry'],
    [['难过', '好累', '压力', '哭', 'emo'], 'sad'],
    [['开心', '高兴', '哈哈', '太棒', '喜欢'], 'happy'],
    [['为什么', '怎么', '什么'], 'curious'],
    [['加油', '你可以'], 'excited'],
    [['困', '睡'], 'sleepy'],
  ];
  for (const [keys, label] of rules) {
    if (keys.some((k) => lower.includes(k))) return label;
  }
  return 'neutral';
}

function choiceAnswer(
  picked: string,
  allKeys: readonly string[],
  confidence: number,
): JevAnswer {
  const probabilities: Record<string, number> = {};
  const rest = allKeys.filter((k) => k !== picked);
  const each = rest.length > 0 ? (1 - confidence) / rest.length : 0;
  for (const k of allKeys) {
    probabilities[k] = k === picked ? confidence : Number(each.toFixed(4));
  }
  return { type: 'choice', choice: picked, probabilities, confidence };
}

function scoreAnswer(levels: unknown[], score: number): JevAnswer {
  const legend: Record<string, string> = {};
  levels.forEach((l, i) => {
    legend[String(i)] = String(l);
  });
  const probabilities: Record<string, number> = {};
  levels.forEach((_, i) => {
    probabilities[String(i)] = i === Math.round(score) ? 0.7 : 0.15;
  });
  return { type: 'score', score, legend, probabilities, confidence: 0.6 };
}

/** 模拟 Jev 评估：读取 state 与 questions，返回形状一致的响应。 */
export function mockJevEvaluate(request: JevRequest): JevResponse {
  const state =
    typeof request.state === 'object' && !Array.isArray(request.state)
      ? (request.state as Record<string, unknown>)
      : { user_speech: String(request.state) };

  const speech = String(state.user_speech ?? '');
  const intent = matchIntent(speech);
  const emotion = matchEmotion(speech);

  const safety = state.safety_flags as Record<string, boolean> | undefined;
  const hardware = state.hardware as Record<string, boolean> | undefined;
  const battery = Number(
    (state.robot_status as Record<string, unknown> | undefined)?.battery_percent ?? 100,
  );

  let safe = !(safety?.emergencyStop || safety?.humanTooClose || safety?.obstacleDetected);
  if (battery < 15 && NEEDS_MOBILITY.includes(intent)) safe = false;
  if (hardware && !hardware.mobility && NEEDS_MOBILITY.includes(intent)) safe = false;
  if (hardware && !hardware.arm && NEEDS_ARM.includes(intent)) safe = false;
  if (hardware && !hardware.speaker && NEEDS_SPEAKER.includes(intent)) safe = false;
  if (hardware && !hardware.camera && NEEDS_CAMERA.includes(intent)) safe = false;

  const vague = intent === 'smalltalk' || /那个|这个|看看|随便|你懂/.test(speech);

  const answers: Record<string, JevAnswer> = {};
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      if (key === 'intent') {
        answers[key] = choiceAnswer(intent, ROBOT_INTENTS, vague ? 0.35 : 0.6);
      } else if (key === 'emotion') {
        answers[key] = choiceAnswer(emotion, EMOTIONS, 0.58);
      } else {
        const keys = Object.keys(question.criteria);
        answers[key] = choiceAnswer(keys[0] ?? 'unknown', keys, 0.5);
      }
    } else if (question.type === 'noul') {
      const noul = key === 'safe_to_execute' ? (safe ? 0.82 : 0.12) : vague ? 0.75 : 0.2;
      answers[key] = { type: 'noul', noul };
    } else {
      const levels = Array.isArray(question.criteria) ? question.criteria : [];
      const urgent = /马上|立刻|快|赶紧|停/.test(speech);
      answers[key] = scoreAnswer(levels, urgent ? 2 : speech ? 1 : 0.4);
    }
  }

  return {
    model: 'mock-jev-1.13',
    answers,
    usage: { input_tokens: 420, output_tokens: 96, cost: 0 },
    id: `mock-${Math.random().toString(36).slice(2, 10)}`,
    provider: 'MockJev',
  };
}