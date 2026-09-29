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
  [['转身', '转向', '转过去', '回头', 'rotate', '左转', '右转'], 'rotate'],
  [['帮我拿', '拿一个', '拿个', '取一下', '捡起', '递给我'], 'fetch'],
  [['看', '看看', '瞧', 'look', '看向'], 'look_at'],
  [['睡觉', '休息', '休眠', '晚安', 'sleep'], 'sleep'],
  [['醒醒', '唤醒', '起床', 'wake'], 'wake'],
  [['你叫什么', '你是谁', '介绍一下', '你会什么', '你能做什么'], 'ask_capability'],
  [['无聊', '没意思', '干嘛呢'], 'bored'],
  [['为什么', '怎么办', '怎么', '思考', '脑筋'], 'think'],
  [['好的', '好呀', '可以', '同意', '没错'], 'affirm'],
  [['不要', '不用', '别', '不对', '拒绝', '取消', '算了吧'], 'deny'],
];

const STYLES = ['gentle', 'normal', 'lively', 'solemn'] as const;

/** 表现力强的关键词 -> lively */
const LIVELY_HINTS = ['跳舞', '舞', '庆祝', '哈哈', '开心', '太棒', '好玩', '游戏'];
/** 克制的关键词 -> gentle */
const GENTLE_HINTS = ['谢谢', '抱歉', '对不起', '难受', '累', '难过', '安静', '慢慢'];

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

function matchStyle(text: string): string {
  const lower = text.toLowerCase();
  if (LIVELY_HINTS.some((k) => lower.includes(k))) return 'lively';
  if (GENTLE_HINTS.some((k) => lower.includes(k))) return 'gentle';
  return 'normal';
}

/**
 * 构造带肩峰的概率分布。
 *
 * 上一版把非选中项全部均分，得到"独峰"或"平峰"两个极端。
 * 真实 Jev 会把概率集中在语义邻近的选项上（"跳舞"→dance 0.45 / sing 0.30 / play 0.15），
 * 于是会出现"top1 明显领先、但整体 confidence 不足"的情况——
 * 这恰恰是最值得在开发阶段就看到的置信度行为，mock 却永远调不出来。
 *
 * 现在给出一组主邻项：主峰 + 若干语义邻居 + 长尾均分。
 */
function choiceAnswer(
  picked: string,
  allKeys: readonly string[],
  confidence: number,
  neighbours: readonly string[] = [],
): JevAnswer {
  const probabilities: Record<string, number> = {};
  // 只对确实存在的 key 分配权重，避免把权重分给不存在的选项
  const near = allKeys.filter((k) => k !== picked && neighbours.includes(k));
  const rest = allKeys.filter((k) => k !== picked && !neighbours.includes(k));

  // 主峰之外的权重按邻居数分摊，剩余的给长尾
  const nearShare = confidence * 0.6;
  const eachNear = near.length > 0 ? nearShare / near.length : 0;
  const tailShare = confidence * 0.4;
  const eachTail = rest.length > 0 ? tailShare / rest.length : 0;

  for (const k of allKeys) {
    let p: number;
    if (k === picked) p = confidence;
    else if (near.includes(k)) p = eachNear;
    else p = eachTail;
    probabilities[k] = Number(p.toFixed(4));
  }
  // 四位小数会累积舍入误差，残差补回主峰，确保和恰为 1。
  // 协议明确要求概率和为 1；mock 若给出 1.56 这类和，
  // 就掩盖了真实模型偶尔返回和不为 1 时应用该如何兜底。
  const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
  probabilities[picked] = Number((probabilities[picked] + (1 - sum)).toFixed(4));
  return { type: 'choice', choice: picked, probabilities, confidence };
}

/** 各意图的语义邻居，用于造出真实的肩峰形状 */
const INTENT_NEIGHBOURS: Partial<Record<RobotIntent, string[]>> = {
  dance: ['sing', 'play', 'hug'],
  sing: ['dance', 'joke', 'play'],
  greet: ['smalltalk', 'praise', 'affirm'],
  goodbye: ['stop', 'sleep', 'smalltalk'],
  joke: ['sing', 'play', 'encourage'],
  play: ['dance', 'joke', 'hug'],
  come_here: ['follow', 'go_back', 'look_at'],
  follow: ['come_here', 'go_back', 'rotate'],
  go_back: ['come_here', 'stop', 'rotate'],
  rotate: ['look_at', 'follow', 'go_back'],
  look_at: ['rotate', 'think', 'come_here'],
  fetch: ['put_down', 'take_photo', 'hug'],
  put_down: ['fetch', 'stop', 'deny'],
  take_photo: ['fetch', 'look_at', 'play'],
  hug: ['dance', 'play', 'praise'],
  sleep: ['goodbye', 'bored', 'smalltalk'],
  wake: ['sleep', 'greet', 'affirm'],
  think: ['ask_capability', 'smalltalk', 'look_at'],
  bored: ['play', 'joke', 'dance'],
  encourage: ['thank', 'hug', 'praise'],
  praise: ['thank', 'encourage', 'hug'],
  thank: ['praise', 'affirm', 'goodbye'],
  stop: ['deny', 'sleep', 'go_back'],
  affirm: ['thank', 'praise', 'deny'],
  deny: ['stop', 'affirm', 'put_down'],
  smalltalk: ['greet', 'think', 'bored'],
  ask_capability: ['smalltalk', 'think', 'praise'],
  unknown: ['smalltalk', 'think', 'bored'],
};

/** 模拟 Jev 评估：读取 state 与 questions，返回形状一致的响应。 */
export function mockJevEvaluate(request: JevRequest): JevResponse {
  const state =
    typeof request.state === 'object' && !Array.isArray(request.state)
      ? (request.state as Record<string, unknown>)
      : { user_speech: String(request.state) };

  const speech = String(state.user_speech ?? '');
  const intent = matchIntent(speech);
  const style = matchStyle(speech);

  const safety = state.safety_flags as Record<string, boolean> | undefined;
  const hardware = state.hardware as Record<string, boolean> | undefined;
  const battery = Number(
    (state.robot_status as Record<string, unknown> | undefined)?.battery_percent ?? 100,
  );

  /**
   * 能力缺口检查。
   * 读的是 state 里的 requested_capabilities——与真实 Jev 拿到的信息一致，
   * 而不是从 intent 反推。真实模式下模型看不到 intent 问题的答案，
   * mock 若偷偷用了，就会在离线阶段给出真实模式永远调不出来的行为。
   */
  const requested = state.requested_capabilities as
    | { capabilities?: string[]; source?: string }
    | undefined;
  const caps = requested?.capabilities ?? [];
  const missingCaps = hardware
    ? caps.filter((c) => hardware[c] === false)
    : [];

  let safe = !(safety?.emergencyStop || safety?.humanTooClose || safety?.obstacleDetected);
  if (battery < 15 && (missingCaps.length > 0 || caps.includes('mobility'))) safe = false;
  if (missingCaps.length > 0) safe = false;
  if (hardware && !hardware.mobility && caps.includes('mobility')) safe = false;
  if (hardware && !hardware.arm && caps.includes('arm')) safe = false;
  if (hardware && !hardware.speaker && caps.includes('speaker')) safe = false;
  if (hardware && !hardware.camera && caps.includes('camera')) safe = false;

  // 意图含糊时给出较低的 confidence，用于验证"反问确认"分支
  const vague = intent === 'smalltalk' || /那个|这个|看看|随便|你懂/.test(speech);

  const answers: Record<string, JevAnswer> = {};
  for (const [key, question] of Object.entries(request.questions)) {
    if (key === 'intent' && question.type === 'choice') {
      answers[key] = choiceAnswer(
        intent,
        ROBOT_INTENTS,
        vague ? 0.35 : 0.78,
        INTENT_NEIGHBOURS[intent] ?? [],
      );
    } else if (key === 'gesture_style' && question.type === 'choice') {
      answers[key] = choiceAnswer(style, STYLES, 0.6);
    } else if (key === 'safe_to_execute' && question.type === 'noul') {
      // 摇摆场景：环境有轻度疑虑但未触发任一红旗，给出落在 0.5 附近的 noul
      const hesitant = !safe && !safety?.emergencyStop && !safety?.humanTooClose
        && !safety?.obstacleDetected && missingCaps.length === 0;
      answers[key] = {
        type: 'noul',
        noul: safe ? 0.88 : hesitant ? 0.5 : 0.1,
      };
    } else if (question.type === 'choice') {
      const keys = Object.keys(question.criteria);
      answers[key] = choiceAnswer(keys[0] ?? 'unknown', keys, 0.5);
    } else if (question.type === 'noul') {
      answers[key] = { type: 'noul', noul: 0.5 };
    }
  }

  return {
    model: 'mock-jev-1.13',
    answers,
    /**
     * token 数为按请求体长度估算，仅供面板显示量级。
     * 真实数值只有打真实 API 才有意义——离线编一个"看起来像真的"的数
     * 只会让人误把估算当成实测。
     */
    usage: { input_tokens: estimateTokens(request), output_tokens: 96, cost: 0 },
    id: `mock-${Math.random().toString(36).slice(2, 10)}`,
    provider: 'MockJev',
  };
}

/** 按序列化后的字节数粗估 token：中文 UTF-8 约 3 字节/token */
function estimateTokens(request: JevRequest): number {
  return Math.max(1, Math.ceil(JSON.stringify(request).length / 3));
}
