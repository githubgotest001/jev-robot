/**
 * 用真实 Jev API 验证项目的真实决策逻辑。
 *
 * 关键：直接复用 src/ 下的代码构造请求，
 * 而不是另写一份副本——副本会与实现漂移，导致验证结果不可信。
 *
 * 用法：node scripts/verify-live.mjs   （需 .env 中配置 JEV_API_KEY）
 */
import { applyEnvFile } from '../server/env.mjs';
import { buildJevRequest, defaultRobotContext, ROBOT_INTENTS } from '../src/jev/robotQuestions.ts';
import { routeAnswers } from '../src/jev/jevProvider.ts';

applyEnvFile();

const ENDPOINT = process.env.JEV_UPSTREAM ?? 'https://openrouter.ai/api/alpha/decisions';
const API_KEY = process.env.JEV_API_KEY ?? '';
const MODEL = process.env.JEV_DEFAULT_MODEL ?? 'typesafe/jev-1.13';

if (!API_KEY) {
  console.error('.env 中缺少 JEV_API_KEY');
  process.exit(1);
}

const POLICY = { autoActThreshold: 0.7, reviewThreshold: 0.45, safetyThreshold: 0.6 };
const HW = { camera: true, speaker: true, mobility: true, arm: true };

/** 覆盖全部意图 + 边界与兜底场景 */
const CASES = [
  // 打招呼类
  ['你好', 'greet'],
  ['嗨，你在吗', 'greet'],
  ['早上好', 'greet'],
  // 告别
  ['再见', 'goodbye'],
  ['我走了', 'goodbye'],
  ['拜拜', 'goodbye'],
  // 确认与否定
  ['好的', 'affirm'],
  ['就这么办', 'affirm'],
  ['不要', 'deny'],
  ['算了吧', 'deny'],
  // 停止
  ['停下', 'stop'],
  ['别动了', 'stop'],
  ['安静', 'stop'],
  // 移动
  ['过来', 'come_here'],
  ['到我这儿来', 'come_here'],
  ['回去', 'go_back'],
  ['归位', 'go_back'],
  ['转过来', 'rotate'],
  ['左转', 'rotate'],
  // 抓取
  ['帮我拿个东西', 'fetch'],
  ['把水递给我', 'fetch'],
  ['放下', 'put_down'],
  ['松手', 'put_down'],
  // 视线
  ['看看那边', 'look_at'],
  ['看向门口', 'look_at'],
  // 社交
  ['谢谢你', 'thank'],
  ['你真棒', 'praise'],
  ['干得好', 'praise'],
  ['讲个笑话', 'joke'],
  ['抱抱我', 'hug'],
  // 表演
  ['跳个舞', 'dance'],
  ['唱首歌', 'sing'],
  // 状态
  ['去睡觉', 'sleep'],
  ['醒醒', 'wake'],
  ['给我拍张照', 'take_photo'],
  ['跟着我', 'follow'],
  ['陪我玩会儿', 'play'],
  ['你会什么', 'ask_capability'],
  ['好无聊', 'bored'],
  ['为什么', 'think'],
  // 情绪（此前曾误判为 unknown）
  ['我有点累了', 'encourage'],
  ['压力好大', 'encourage'],
  ['emo了', 'encourage'],
  // 兜底场景
  // 无意义输入：语气词属肯定表达，字面无意义则落到 unknown
  ['嗯嗯嗯', 'affirm'],
  ['zzzz', 'unknown'],
];

let pass = 0;
let fail = 0;
const failed = [];
let totalCost = 0;

async function probe(text, over) {
  const ctx = defaultRobotContext({
    utterance: text,
    hardware: HW,
    ...over,
  });
  const req = buildJevRequest(ctx);
  req.model = MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const data = await res.json();
    totalCost += data.usage?.cost ?? 0;
    const trace = [];
    const routed = routeAnswers(data.answers, ctx, POLICY, trace);
    return { data, routed, trace };
  } finally {
    clearTimeout(timer);
  }
}

console.log('真实 Jev 决策验证 · ' + CASES.length + ' 个用例\n');
for (const [text, expected] of CASES) {
  try {
    const { data, routed } = await probe(text);
    const got = data.answers.intent?.choice;
    const ok = got === expected;
    if (ok) pass += 1;
    else {
      fail += 1;
      failed.push('「' + text + '」 期望 ' + expected + ' 实得 ' + got);
    }
    const mark = ok ? 'ok  ' : 'FAIL';
    console.log(
      mark + ' ' + text.padEnd(14) +
      ' -> ' + String(got).padEnd(15) +
      ' conf=' + (data.answers.intent?.confidence ?? 0).toFixed(2) +
      '  ' + routed.plan.actions.map((a) => a.actionId).join(',')
    );
  } catch (err) {
    fail += 1;
    failed.push('「' + text + '」 请求失败: ' + err.message);
    console.log('ERR  ' + text + ' -> ' + err.message);
  }
}

// 安全闸门：关闭底盘后要求移动
console.log('\n[安全闸门]');
try {
  const { routed } = await probe('过来', { hardware: { ...HW, mobility: false } });
  const moved = routed.plan.actions.some((a) => a.actionId.indexOf('base.move') === 0);
  if (!moved && routed.executed === false) { pass += 1; console.log('ok   底盘不可用时已拦截'); }
  else { fail += 1; failed.push('安全闸门未生效'); console.log('FAIL 底盘不可用时未拦截'); }
} catch (e) { fail += 1; failed.push('安全闸门用例异常: ' + e.message); }

// 未知 choice 的兜底
console.log('\n[兜底]');
{
  const fake = {
    intent: { type: 'choice', choice: 'teleport', probabilities: { teleport: 1 }, confidence: 1 },
    safe_to_execute: { type: 'noul', noul: 0.95 },
    gesture_style: { type: 'choice', choice: 'normal', probabilities: { normal: 1 }, confidence: 1 },
  };
  const trace = [];
  const r = routeAnswers(fake, defaultRobotContext({ utterance: 'x', hardware: HW }), POLICY, trace);
  if (r.intent === 'unknown' && r.plan.actions.length > 0) {
    pass += 1; console.log('ok   未列举 choice 降级为 unknown 且仍有动作');
  } else { fail += 1; failed.push('未列举 choice 兜底失效'); console.log('FAIL 未列举 choice 兜底失效'); }

  const trace2 = [];
  const r2 = routeAnswers({}, defaultRobotContext({ utterance: 'x', hardware: HW }), POLICY, trace2);
  if (r2.plan.actions.length > 0) { pass += 1; console.log('ok   空 answers 仍有动作'); }
  else { fail += 1; failed.push('空 answers 兜底失效'); console.log('FAIL 空 answers 兜底失效'); }
}

console.log('\n' + '='.repeat(56));
console.log('通过 ' + pass + ' / ' + (pass + fail) + '   累计花费 $' + totalCost.toFixed(6));
if (fail > 0) {
  console.log('\n未通过：');
  failed.forEach((f) => console.log('  x ' + f));
}
console.log('\n覆盖意图 ' + new Set(CASES.map((c) => c[1])).size + ' / ' + ROBOT_INTENTS.length);