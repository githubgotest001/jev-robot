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
  planDegraded,
  planFallback,
  planClarification,
  filterActions,
  riskOfIntent,
  declaredRequires,
  hardwareUsedBy,
} from '../src/jev/actionRouter.ts';
import { routeAnswers } from '../src/jev/jevProvider.ts';
import { mockJevEvaluate } from '../src/jev/mockJev.ts';
import { asChoiceAnswer, asNoulAnswer, asScoreAnswer } from '../src/jev/jevTypes.ts';
import { SimulationEngine } from '../src/engine/simulationEngine.ts';
import { DEFAULT_CONFIG, sanitizeConfig } from '../src/jev/config.ts';

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
/** 与 DEFAULT_POLICY 保持一致；缺字段会让 routeAnswers 读不到摇摆区间 */
const policy = {
  autoActThreshold: 0.7,
  reviewThreshold: 0.45,
  safetyThreshold: 0.6,
  safetyBand: [0.4, 0.6],
  highRiskAutoActThreshold: 0.85,
};
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

console.log('[7] 模型输出收敛');// 真实 Jev 返回的 choice / noul / score 三种形状
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

// ── 回归：requires 声明必须与编排实际用到的硬件对齐 ──
// 历史上 come_here / go_back / rotate 漏了声明，导致拒绝话术拿不到真实原因，
// 只能退化成一句"没法安全执行"，用户看不出到底缺什么。
console.log('[8] requires 与编排对齐');
for (const intent of ROBOT_INTENTS) {
  const plan = planForIntent(intent, 'happy', planCtx);
  const declared = declaredRequires(intent);
  // 编排里出现的每一类硬件都必须在 requires 中声明，否则闸门拦不住
  const used = hardwareUsedBy(plan.actions.map((a) => a.actionId));
  const undeclared = used.filter((u) => !declared.includes(u));
  check(intent + ' 编排硬件均已声明', undeclared.length === 0,
    undeclared.join(',') + ' | declared=' + declared.join(','));
  check(intent + ' 声明了风险等级',
    ['none', 'low', 'high'].includes(riskOfIntent(intent)));
}

// 缺硬件时拒绝话术必须说清缺什么，而不是通用兜底
for (const [intent, hwKey, expectWord] of [
  ['come_here', 'mobility', '轮子'],
  ['go_back', 'mobility', '轮子'],
  ['rotate', 'mobility', '轮子'],
  ['fetch', 'arm', '手'],
  ['joke', 'speaker', '扬声器'],
  ['take_photo', 'camera', '摄像头'],
]) {
  const ctx = { ...planCtx, hardware: { ...HW, [hwKey]: false } };
  const u = planRefusal(intent, ctx).utterance;
  check('拒绝话术说明缺失硬件 · ' + intent, u.indexOf(expectWord) >= 0, u);
}

// ── 回归：主动作被硬件滤掉时不能还说"来啦" ──
console.log('[9] 硬件受限降级');
{
  const ctx = { ...planCtx, hardware: { ...HW, mobility: false } };
  const r = routeAnswers(
    answers({ intent: { type: 'choice', choice: 'come_here', probabilities: { come_here: 1 }, confidence: 1 } }),
    mkCtx({ utterance: '过来', hardware: { ...HW, mobility: false } }), policy, []);
  check('缺底盘标记为降级', r.path === 'degraded', r.path);
  check('降级话术不再说"来啦"', r.plan.utterance.indexOf('来啦') < 0, r.plan.utterance);
  check('降级话术说明缺轮子', r.plan.utterance.indexOf('轮子') >= 0, r.plan.utterance);
  check('降级不声称已执行', r.executed === false);
  check('降级仍有动作', r.plan.actions.length > 0);
  // 头部的 look_at 仍可用：缺底盘时至少转头看向用户
  check('降级保留可执行的部分', r.plan.actions.some((a) => a.actionId === 'head.look_at'),
    r.plan.actions.map((a) => a.actionId).join(','));
  check('降级有替代选项', r.plan.choices.length > 0);
  check('planDegraded 剔除不可用动作',
    !planDegraded('come_here', ['mobility'], ctx).actions.some((a) => a.actionId.startsWith('base.')));
}

// ── 回归：noul 的摇摆态应走反问，而不是误判为不安全 ──
// 官方指出 noul ≈ 0.5 表示"不知道"，是第三种结果。旧实现只有一刀切，
// 会把"不确定安全"当成"不安全"，机器人无缘无故拒绝合理请求。
console.log('[10] noul 三态');
{
  const noul = (v) => routeAnswers(answers({ safe_to_execute: { type: 'noul', noul: v } }), mkCtx(), policy, []);
  check('noul=0.1 拦截', noul(0.1).path === 'blocked', noul(0.1).path);
  check('noul=0.9 放行', noul(0.9).path === 'direct', noul(0.9).path);
  check('noul=0.5 摇摆走反问', noul(0.5).path === 'undecided', noul(0.5).path);
  check('noul=0.45 摇摆走反问', noul(0.45).path === 'undecided', noul(0.45).path);
  check('noul=0.35 拦截', noul(0.35).path === 'blocked', noul(0.35).path);
  // 摇摆态必须真的去问，而不是默默拦下
  check('摇摆态话术是反问', noul(0.5).plan.utterance.indexOf('没太确定') >= 0, noul(0.5).plan.utterance);
  check('摇摆态不声称已执行', noul(0.5).executed === false);
  check('摇摆态不拦截到底（有动作）', noul(0.5).plan.actions.length > 0);
  // 边界：区间两端
  check('noul=0.4 下界属摇摆', noul(0.4).path === 'undecided', noul(0.4).path);
  check('noul=0.6 上界属摇摆', noul(0.6).path === 'undecided', noul(0.6).path);
}

// ── 回归：高风险意图应使用更严的执行门槛 ──
console.log('[11] 风险分级阈值');
{
  // confidence 0.8：高于普通门槛 0.70，低于高风险门槛 0.85
  const mid = { type: 'choice', probabilities: { x: 1 }, confidence: 0.8 };
  const lowRisk = routeAnswers(answers({ intent: { ...mid, choice: 'dance' } }), mkCtx({ utterance: '跳舞' }), policy, []);
  const highRisk = routeAnswers(answers({ intent: { ...mid, choice: 'come_here' } }), mkCtx({ utterance: '过来' }), policy, []);
  check('低风险 0.80 直接执行', lowRisk.path === 'direct', lowRisk.path);
  check('高风险 0.80 改为反问', highRisk.path === 'ask', highRisk.path);
  check('come_here 标记为高风险', riskOfIntent('come_here') === 'high');
  check('follow 标记为高风险', riskOfIntent('follow') === 'high');
  check('dance 非高风险', riskOfIntent('dance') !== 'high');
  // 高风险门槛更高时，路径内说明应体现出来
  check('高风险反问带门槛说明',
    highRisk.path === 'ask' && planForIntent('come_here', 'happy', planCtx).actions.length > 0);
}

// ── 回归：非法 choice 不得沿用为非法选项计算的 confidence ──
// 旧实现在 choice 非法时从 probabilities 取 top1，却沿用原 confidence，
// 而那个值是针对非法选项算的，与"合法候选里谁最像"是两回事。
console.log('[12] 非法 choice 的置信度回收');
{
  // 合法候选里分布很平：dance 0.3 / greet 0.3，其余更低 -> 集中度不足
  const flat = { type: 'choice', choice: 'teleport', confidence: 1,
    probabilities: { teleport: 0.9, dance: 0.3, greet: 0.3 } };
  const r = routeAnswers(answers({ intent: flat }), mkCtx(), policy, []);
  check('非法 choice 回退到合法候选', r.intent === 'dance' || r.intent === 'greet', r.intent);
  check('回收后不因非法项的高 confidence 而直接执行', r.path !== 'direct', r.path);

  // 集中时仍可执行：dance 0.85 / greet 0.1 -> 合法候选内集中度 ≈ 0.89，高于普通门槛 0.70
  const peaked = { type: 'choice', choice: 'teleport', confidence: 0.1,
    probabilities: { teleport: 0.05, dance: 0.85, greet: 0.1 } };
  const r2 = routeAnswers(answers({ intent: peaked }), mkCtx(), policy, []);
  check('集中时仍可执行', r2.path === 'direct', r2.path);
  check('回收选中了 dance', r2.intent === 'dance', r2.intent);

  // 完全无法回收
  const r3 = routeAnswers(answers({ intent: { type: 'choice', choice: 'teleport', probabilities: {}, confidence: 1 } }),
    mkCtx(), policy, []);
  check('无合法候选时按 unknown 处理', r3.intent === 'unknown', r3.intent);
}

// ── 回归：gesture_style 应改幅度与快慢，而不是一味放慢 ──
// lively 曾把 durationScale 放大到 1.15，结果"活泼"反而让动作变慢 15%，
// 与 criteria 写的"动作幅度大、活泼有活力"正相反。
console.log('[13] 表现风格作用方向');
{
  const at = (style, id) => planForIntent('dance', 'joy', { ...planCtx, style })
    .actions.find((a) => a.actionId === id);
  const lively = at('lively', 'arm.dance');
  const gentle = at('gentle', 'arm.dance');
  const normal = at('normal', 'arm.dance');
  check('lively 放大力度参数', lively.params.intensity > normal.params.intensity,
    lively.params.intensity + ' vs ' + normal.params.intensity);
  check('gentle 收敛力度参数', gentle.params.intensity < normal.params.intensity,
    gentle.params.intensity + ' vs ' + normal.params.intensity);
  check('lively 节奏更快', lively.durationScale < 1, String(lively.durationScale));
  check('gentle 节奏更沉稳', gentle.durationScale > 1, String(gentle.durationScale));
  // 次数与保持时长属语义，不应被力度缩放改动（greet 的编排里有 head.nod）
  const nodLively = planForIntent('greet', 'happy', { ...planCtx, style: 'lively' })
    .actions.find((a) => a.actionId === 'head.nod');
  const nodNormal = planForIntent('greet', 'happy', planCtx)
    .actions.find((a) => a.actionId === 'head.nod');
  check('次数类参数不被缩放', nodLively.params.times === nodNormal.params.times,
    String(nodLively.params.times) + ' vs ' + String(nodNormal.params.times));
  // 缩放后的参数仍须合法
  for (const style of ['gentle', 'normal', 'lively', 'solemn']) {
    const acts = planForIntent('fetch', 'happy', { ...planCtx, style }).actions;
    check('风格 ' + style + ' 缩放后参数合法', acts.every(validateParams));
  }
}

// ── 回归：state 必须自带安全闸门可判的信息 ──
// 三个问题在同一个 state 上并行评估，彼此看不到对方答案，
// 因此后两个问题不得引用 intent；安全闸门改读 requested_capabilities。
console.log('[14] state 与问题自洽');
{
  const ctx = mkCtx({ utterance: '过来' });
  const st = buildJevRequest(ctx).state;
  check('state 含 requested_capabilities', !!st.requested_capabilities);
  check('过来需要 mobility', st.requested_capabilities.capabilities.includes('mobility'),
    JSON.stringify(st.requested_capabilities.capabilities));
  check('available 列出可用能力', st.requested_capabilities.available.includes('mobility'));

  const talk = buildJevRequest(mkCtx({ utterance: '今天天气不错' })).state;
  check('闲聊不误报能力需求', talk.requested_capabilities.capabilities.length === 0,
    JSON.stringify(talk.requested_capabilities.capabilities));
  check('未识别时 source=unknown', talk.requested_capabilities.source === 'unknown');

  // instructions 不得引用 state 里不存在的字段（含嵌套字段）
  const req = buildJevRequest(mkCtx({ utterance: '过来' }));
  const refs = (s) => (String(s).match(/`([a-z_]+)`/g) || []).map((x) => x.slice(1, -1));
  // 收集 state 的全部字段名：顶层 + 一层嵌套，覆盖 requested_capabilities 内的情况
  const stateFields = new Set(Object.keys(st));
  for (const v of Object.values(st)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v)) stateFields.add(k);
    }
  }
  for (const [key, q] of Object.entries(req.questions)) {
    const bad = refs(q.instructions).filter((f) => !stateFields.has(f));
    check('问题 ' + key + ' 只引用 state 真实字段', bad.length === 0, bad.join(','));
  }
  // 关键约束：不得引用 intent
  const safetyRefs = refs(req.questions.safe_to_execute.instructions);
  check('安全闸门不引用 intent', !safetyRefs.includes('intent'), safetyRefs.join(','));
  const styleRefs = refs(req.questions.gesture_style.instructions);
  check('表现风格不引用 intent', !styleRefs.includes('intent'), styleRefs.join(','));
}

// ── 回归：停止指令必须抢占，而非排在队尾 ──
// 旧实现一律入队追加，"停下"会等正在执行的 dance 播完才生效，
// 对能移动的底盘是安全问题。
console.log('[15] 停止指令抢占');
{
  // 引擎是帧驱动的：enqueue 只入队，tick 才真正开始执行。
  // 不驱动 tick 就断言 timeline，看到的永远是空数组。
  const eng = new SimulationEngine();
  eng.enqueue([{ actionId: 'arm.dance', params: { intensity: 0.9 } }]);
  eng.tick(1000);
  check('tick 后动作已开始',
    eng.getSnapshot().timeline.some((e) => e.actionId === 'arm.dance' && e.status === 'running'),
    JSON.stringify(eng.getSnapshot().timeline.map((e) => e.actionId + ':' + e.status)));

  eng.enqueue([{ actionId: 'screen.set_expression', params: { expression: 'neutral', holdMs: 500 } },
               { actionId: 'base.stop', params: {} }], 'preempt');
  eng.tick(1100);
  const snap = eng.getSnapshot();
  check('抢占后旧动作被标记为 interrupted',
    snap.timeline.some((e) => e.actionId === 'arm.dance' && e.status === 'interrupted'),
    JSON.stringify(snap.timeline.map((e) => e.actionId + ':' + e.status)));
  check('抢占后 base.stop 生效', snap.currentActionId === 'screen.set_expression' || snap.busy,
    String(snap.currentActionId));
  check('base.stop 可打断', ACTION_MAP.get('base.stop').interruptible === true);

  // 优先级参与调度：head.nod(40) 高于 screen.blink(10)，应就地抢占
  const eng2 = new SimulationEngine();
  eng2.enqueue([{ actionId: 'screen.blink', params: { times: 1 } }]);
  eng2.tick(1000);
  check('blink 开始执行',
    eng2.getSnapshot().timeline.some((e) => e.actionId === 'screen.blink' && e.status === 'running'));
  eng2.enqueue([{ actionId: 'head.nod', params: { times: 1 } }], 'queue');
  eng2.tick(1100);
  check('高优先级新编排抢占当前动作',
    eng2.getSnapshot().timeline.some((e) => e.actionId === 'screen.blink' && e.status === 'interrupted'),
    JSON.stringify(eng2.getSnapshot().timeline.map((e) => e.actionId + ':' + e.status)));
  check('抢占后新动作接管',
    eng2.getSnapshot().timeline.some((e) => e.actionId === 'head.nod' && e.status === 'running'));

  // 反向：低优先级新编排应排队等待，不打断
  const eng3 = new SimulationEngine();
  eng3.enqueue([{ actionId: 'head.nod', params: { times: 1 } }]);
  eng3.tick(1000);
  eng3.enqueue([{ actionId: 'screen.blink', params: { times: 1 } }], 'queue');
  eng3.tick(1100);
  check('低优先级新编排不打断当前动作',
    !eng3.getSnapshot().timeline.some((e) => e.actionId === 'screen.blink'),
    JSON.stringify(eng3.getSnapshot().timeline.map((e) => e.actionId + ':' + e.status)));
  check('当前动作仍在运行',
    eng3.getSnapshot().timeline.some((e) => e.actionId === 'head.nod' && e.status === 'running'));

  const r = routeAnswers(
    answers({ intent: { type: 'choice', choice: 'stop', probabilities: { stop: 1 }, confidence: 1 } }),
    mkCtx({ utterance: '停下' }), policy, []);
  check('stop 标记为抢占', r.preempt === true);
  check('非 stop 不抢占', routeAnswers(answers(), mkCtx(), policy, []).preempt === false);
}

console.log('[16] 摇摆区间配置校验');
{
  const bad = sanitizeConfig({ ...DEFAULT_CONFIG, policy: { ...policy, safetyBand: [0.7, 0.3] } });
  check('倒置区间回落默认', bad.policy.safetyBand[0] < bad.policy.safetyBand[1],
    JSON.stringify(bad.policy.safetyBand));
  const same = sanitizeConfig({ ...DEFAULT_CONFIG, policy: { ...policy, safetyBand: [0.5, 0.5] } });
  check('相等区间回落默认', same.policy.safetyBand[0] < same.policy.safetyBand[1]);
  const junk = sanitizeConfig({ ...DEFAULT_CONFIG, policy: { ...policy, safetyBand: 'x' } });
  check('非数组区间回落默认', Array.isArray(junk.policy.safetyBand) && junk.policy.safetyBand.length === 2);
  const ok = sanitizeConfig({ ...DEFAULT_CONFIG, policy: { ...policy, safetyBand: [0.3, 0.7] } });
  check('合法区间保留', ok.policy.safetyBand[0] === 0.3 && ok.policy.safetyBand[1] === 0.7);
}

console.log('[17] Mock 概率分布形状');
{
  const resp = mockJevEvaluate(buildJevRequest(mkCtx({ utterance: '给我跳个舞' })));
  const p = resp.answers.intent.probabilities;
  check('选中项概率最高', p.dance === Math.max(...Object.values(p)), String(p.dance));
  check('主峰有语义邻居肩峰', p.sing > 0 && p.sing < p.dance, 'sing=' + p.sing);
  check('概率和为 1',
    Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) < 0.01,
    String(Object.values(p).reduce((a, b) => a + b, 0)));
  check('Mock 给出全部候选的概率', Object.keys(p).length === ROBOT_INTENTS.length,
    String(Object.keys(p).length));
}

console.log('\n' + '='.repeat(52));
console.log('通过 ' + pass + ' / ' + (pass + fail));
if (fail > 0) {
  console.log('\n失败项：');
  failures.slice(0, 40).forEach((f) => console.log('  x ' + f));
  if (failures.length > 40) console.log('  ... 另有 ' + (failures.length - 40) + ' 项');
  process.exit(1);
}
console.log('全部通过');