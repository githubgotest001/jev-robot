/**
 * Jev 决策层全面测试。
 *
 * 覆盖：
 *   1. 意图体系完整性（枚举 / criteria / 编排三者对齐）
 *   2. 动作库引用完整性（编排引用的动作必须存在；反向检查死动作）
 *   3. 全部意图的编排可生成，且动作参数合法
 *   4. 兜底路径（非法 choice / 缺字段 / 空编排 / 低置信度 / 安全拦截）
 *   5. 硬件与电量约束下的动作过滤
 *   6. Mock 与真实协议形状一致性
 *   7. 模型 JSON 输出的解析与收敛
 *
 * 运行：node scripts/test-jev.mjs
 */
import { ACTION_LIBRARY, ACTION_MAP } from '../src/domain/actionLibrary.ts';
import {
  ROBOT_INTENTS,
  defaultRobotContext,
  buildJevRequest,
} from '../src/jev/robotQuestions.ts';
import {
  planForIntent,
  planRefusal,
  planFallback,
  planClarification,
  filterActions,
} from '../src/jev/actionRouter.ts';
import { routeAnswers } from '../src/jev/jevProvider.ts';
import { mockJevEvaluate } from '../src/jev/mockJev.ts';
import { asChoiceAnswer, asNoulAnswer, asScoreAnswer } from '../src/jev/jevTypes.ts';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(name + (detail ? ' -> ' + detail : ''));
  }
}

const HW = { camera: true, speaker: true, mobility: true, arm: true };
const policy = { autoActThreshold: 0.7, reviewThreshold: 0.45, safetyThreshold: 0.6 };
const mkCtx = (over = {}) => defaultRobotContext({ utterance: 'test', hardware: HW, ...over });
const planCtx = { battery: 100, busy: false, hardware: HW, holdingObject: false, style: 'normal' };

function validateParams(action) {
  const def = ACTION_MAP.get(action.actionId);
  if (!def) return false;
  for (const [k, v] of Object.entries(action.params || {})) {
    const p = def.params.find((x) => x.name === k);
    if (!p) return false;
    if (p.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      if (p.min !== undefined && v < p.min) return false;
      if (p.max !== undefined && v > p.max) return false;
    }
    if (p.type === 'enum' && p.options && !p.options.includes(String(v))) return false;
  }
  return true;
}

console.log('\n[1] 意图体系完整性');
const intentQ = buildJevRequest(mkCtx()).questions.intent;
check('intent 为 choice', intentQ.type === 'choice');
const critKeys = Object.keys(intentQ.criteria);
check('criteria 数量匹配枚举', critKeys.length === ROBOT_INTENTS.length,
  critKeys.length + ' vs ' + ROBOT_INTENTS.length);
for (const it of ROBOT_INTENTS) {
  check('criteria 含 ' + it, critKeys.includes(it));
  const d = intentQ.criteria[it];
  check('criteria[' + it + '] 有中文描述', typeof d === 'string' && d.length > 2);
}

console.log('[2] 动作库引用完整性');
const referenced = new Set();
// 需覆盖多种上下文：不同风格、持有物与否，否则会漏检条件分支里的动作
const ctxVariants = [];
for (const style of ['gentle', 'normal', 'lively', 'solemn']) {
  for (const holding of [false, true]) {
    ctxVariants.push({ ...planCtx, style, holdingObject: holding });
  }
}
for (const intent of ROBOT_INTENTS) {
  for (const c of ctxVariants) {
    for (const a of planForIntent(intent, 'happy', c).actions) referenced.add(a.actionId);
  }
}
for (const id of referenced) check('引用的动作存在 ' + id, ACTION_MAP.has(id));
const dead = ACTION_LIBRARY.map((a) => a.id).filter((id) => !referenced.has(id));
check('无死动作', dead.length === 0, dead.join(','));

console.log('[3] 全部意图编排');
for (const intent of ROBOT_INTENTS) {
  const p = planForIntent(intent, 'happy', planCtx);
  check(intent + ' 有话术', typeof p.utterance === 'string' && p.utterance.length > 0);
  check(intent + ' 动作非空', p.actions.length > 0);
  check(intent + ' 参数合法', p.actions.every(validateParams));
  check(intent + ' 追问 1~4', p.choices.length > 0 && p.choices.length <= 4);
  const ids = p.actions.map((a) => a.actionId);
  check(intent + ' 无重复动作', new Set(ids).size === ids.length, ids.join(','));
}

console.log('[4] 兜底路径');
const answers = (over = {}) => ({
  intent: { type: 'choice', choice: 'greet', probabilities: { greet: 1 }, confidence: 1 },
  safe_to_execute: { type: 'noul', noul: 0.95 },
  gesture_style: { type: 'choice', choice: 'normal', probabilities: { normal: 1 }, confidence: 1 },
  ...over,
});

let r = routeAnswers(answers(), mkCtx(), policy, []);
check('正常直接执行', r.executed && r.intent === 'greet');
check('正常有动作', r.plan.actions.length > 0);

r = routeAnswers(answers({ intent: { type: 'choice', choice: 'teleport', probabilities: { teleport: 1 }, confidence: 1 } }), mkCtx(), policy, []);
check('未列举 choice -> unknown', r.intent === 'unknown', r.intent);
check('未列举 choice 仍有动作', r.plan.actions.length > 0);

r = routeAnswers(answers({ intent: { type: 'choice', choice: 'dance', probabilities: { dance: 0.9, teleport: 0.1 }, confidence: 0.9 } }), mkCtx(), policy, []);
check('合法 choice 不受多余概率影响', r.intent === 'dance', r.intent);

r = routeAnswers({ intent: { type: 'choice' } }, mkCtx(), policy, []);
check('intent 缺字段不崩溃', r.plan.actions.length > 0);
r = routeAnswers({}, mkCtx(), policy, []);
check('空 answers 不崩溃', r.plan.actions.length > 0);
r = routeAnswers({ intent: { type: 'choice', choice: 123, probabilities: null, confidence: 'x' } }, mkCtx(), policy, []);
check('类型错误不崩溃', r.plan.actions.length > 0);

// 注意：intent 字段保留 Jev 的原始判定，便于调试面板如实展示；
// 低置信度改变的是编排路径（用 unknown 话术），而非 intent 值本身。
r = routeAnswers(answers({ intent: { type: 'choice', choice: 'dance', probabilities: { dance: 0.3 }, confidence: 0.3 } }), mkCtx(), policy, []);
check('低置信度用 unknown 话术', r.plan.utterance.indexOf('不太懂') >= 0, r.plan.utterance);
check('低置信度仍保留原始 intent 供调试', r.intent === 'dance', r.intent);
check('低置信度有引导选项', r.plan.choices.length > 0);
r = routeAnswers(answers({ intent: { type: 'choice', choice: 'dance', probabilities: { dance: 0.5 }, confidence: 0.5 } }), mkCtx(), policy, []);
check('中置信度反问', r.plan.utterance.indexOf('没太确定') >= 0);

r = routeAnswers(answers({ safe_to_execute: { type: 'noul', noul: 0.1 } }), mkCtx(), policy, []);
check('安全拦截不执行', r.executed === false);

r = routeAnswers(answers({ gesture_style: { type: 'choice', choice: 'insane', probabilities: {}, confidence: 1 } }), mkCtx(), policy, []);
check('非法 style -> normal', r.style === 'normal', r.style);

for (const s of ['gentle', 'normal', 'lively', 'solemn']) {
  check('风格 ' + s + ' 产出动作', planForIntent('dance', 'joy', { ...planCtx, style: s }).actions.length > 0);
}

check('planFallback 有动作', planFallback().actions.length > 0);
check('planClarification 有追问', planClarification().choices.length > 0);
check('planRefusal 有动作', planRefusal('dance', planCtx).actions.length > 0);

r = routeAnswers(answers({ intent: { type: 'choice', choice: 'fetch', probabilities: { fetch: 1 }, confidence: 1 } }),
  mkCtx({ hardware: { ...HW, arm: false } }), policy, []);
check('硬件缺失空编排时追加保底', r.plan.actions.length > 0);

// 持有物状态应影响 put_down 的编排：夹爪收紧 -> arm.release
const holdingCtx = mkCtx();
holdingCtx.pose = { ...holdingCtx.pose, gripper: 0.8 };
r = routeAnswers(answers({ intent: { type: 'choice', choice: 'put_down', probabilities: { put_down: 1 }, confidence: 1 } }),
  holdingCtx, policy, []);
check('持有物时 put_down 执行 arm.release',
  r.plan.actions.some((a) => a.actionId === 'arm.release'),
  JSON.stringify(r.plan.actions.map((a) => a.actionId)));

// 未持有时不应释放
const emptyCtx = mkCtx();
r = routeAnswers(answers({ intent: { type: 'choice', choice: 'put_down', probabilities: { put_down: 1 }, confidence: 1 } }),
  emptyCtx, policy, []);
check('未持有时 put_down 不执行 arm.release',
  !r.plan.actions.some((a) => a.actionId === 'arm.release'));

console.log('[5] 硬件与电量约束');
const noMob = { battery: 100, busy: false, hardware: { ...HW, mobility: false }, holdingObject: false, style: 'normal' };
check('底盘不可用过滤移动', !planForIntent('come_here', 'happy', noMob).actions.some((a) => a.actionId.indexOf('base.move') === 0));
const lowBat = { battery: 5, busy: false, hardware: HW, holdingObject: false, style: 'normal' };
check('低电量过滤移动', !planForIntent('come_here', 'happy', lowBat).actions.some((a) => a.actionId.indexOf('base.move') === 0));
const noSpk = { battery: 100, busy: false, hardware: { ...HW, speaker: false }, holdingObject: false, style: 'normal' };
check('扬声器缺失过滤声音', !planForIntent('joke', 'excited', noSpk).actions.some((a) => a.actionId.indexOf('audio.') === 0));
const filtered = filterActions(
  [{ actionId: 'base.move', params: {} }, { actionId: 'arm.wave', params: {} },
   { actionId: 'audio.beep', params: {} }, { actionId: 'screen.blink', params: {} }],
  { ...planCtx, battery: 5, hardware: { ...HW, arm: false, speaker: false } });
check('filterActions 精确剔除', filtered.length === 1 && filtered[0].actionId === 'screen.blink');

console.log('[6] Mock 与协议一致性');
const req = buildJevRequest(mkCtx({ utterance: '给我跳个舞' }));
check('请求含三个问题', Object.keys(req.questions).length === 3, String(Object.keys(req.questions).length));
const mockResp = mockJevEvaluate(req);
check('Mock 返回 answers', !!mockResp.answers);
check('Mock intent=choice', mockResp.answers.intent && mockResp.answers.intent.type === 'choice');
check('Mock safe=noul', mockResp.answers.safe_to_execute && mockResp.answers.safe_to_execute.type === 'noul');
check('Mock style=choice', mockResp.answers.gesture_style && mockResp.answers.gesture_style.type === 'choice');
check('Mock 命中 dance', mockResp.answers.intent.choice === 'dance', mockResp.answers.intent.choice);
check('Mock 置信度足够执行', mockResp.answers.intent.confidence >= policy.autoActThreshold);
const mr = routeAnswers(mockResp.answers, mkCtx({ utterance: '给我跳个舞' }), policy, []);
check('Mock 响应可被消费', mr.plan.actions.length > 0 && mr.intent === 'dance');

const probes = [
  ['你好', 'greet'], ['再见', 'goodbye'], ['停下', 'stop'], ['过来', 'come_here'],
  ['回去', 'go_back'], ['转身', 'rotate'], ['帮我拿', 'fetch'], ['放下', 'put_down'],
  ['看看那边', 'look_at'], ['谢谢', 'thank'], ['你真棒', 'praise'], ['讲个笑话', 'joke'],
  ['加油', 'encourage'], ['抱抱', 'hug'], ['跳舞', 'dance'], ['唱歌', 'sing'],
  ['睡觉', 'sleep'], ['醒醒', 'wake'], ['拍照', 'take_photo'], ['跟着我', 'follow'],
  ['陪我玩', 'play'], ['你会什么', 'ask_capability'], ['无聊', 'bored'],
  ['为什么', 'think'], ['好的', 'affirm'], ['不要', 'deny'],
];
for (const [text, want] of probes) {
  const resp = mockJevEvaluate(buildJevRequest(mkCtx({ utterance: text })));
  check('Mock 识别 ' + text + ' -> ' + want, resp.answers.intent.choice === want, 'got ' + resp.answers.intent.choice);
}
const vague = mockJevEvaluate(buildJevRequest(mkCtx({ utterance: '嗯嗯嗯' })));
check('无关键词时低置信度', vague.answers.intent.confidence < policy.autoActThreshold);

console.log('[7] 模型输出收敛');
// 真实 Jev 返回的 choice / noul / score 三种形状
const rawChoice = { type: 'choice', choice: 'dance', probabilities: { dance: 0.9, greet: 0.1 }, confidence: 0.88 };
const ca = asChoiceAnswer(rawChoice);
check('choice 收敛', ca.choice === 'dance' && ca.confidence === 0.88);
check('choice 概率保留', Object.keys(ca.probabilities).length === 2);
check('null 收敛为 null', asChoiceAnswer(null) === null);
check('类型不符收敛为 null', asChoiceAnswer({ type: 'noul', noul: 0.5 }) === null);
const clampedHi = asChoiceAnswer({ type: 'choice', choice: 'x', probabilities: {}, confidence: 5 });
check('confidence 上限收敛', clampedHi.confidence === 1);
const clampedLo = asNoulAnswer({ type: 'noul', noul: -3 });
check('noul 下限收敛', clampedLo.noul === 0);
const nanNoul = asNoulAnswer({ type: 'noul', noul: 'abc' });
check('noul NaN 收敛为 0', Number.isFinite(nanNoul.noul));
const sc = asScoreAnswer({ type: 'score', score: 1.66, legend: { 0: 'a' }, probabilities: { 0: 0.34, 1: 0.66 }, confidence: 0.49 });
check('score 保留小数', sc.score === 1.66);
check('score 收敛 null', asScoreAnswer(undefined) === null);
check('noul 类型校验', asNoulAnswer({ type: 'choice', choice: 'a', probabilities: {}, confidence: 1 }) === null);

console.log('\n' + '='.repeat(52));
console.log('通过 ' + pass + ' / ' + (pass + fail));
if (fail > 0) {
  console.log('\n失败项：');
  failures.slice(0, 40).forEach((f) => console.log('  x ' + f));
  if (failures.length > 40) console.log('  ... 另有 ' + (failures.length - 40) + ' 项');
  process.exit(1);
}
console.log('全部通过');