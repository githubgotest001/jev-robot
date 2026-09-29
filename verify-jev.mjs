/**
 * 用真实 Jev API 验证协议形状。
 *
 * 配置从项目根目录的 .env 读取（与 npm run proxy 同源），也接受环境变量覆盖。
 * 密钥不会被打印到输出。
 *
 * 用法：
 *   node verify-jev.mjs
 */

import { applyEnvFile } from './server/env.mjs';

applyEnvFile();

const ENDPOINT = process.env.JEV_UPSTREAM ?? 'https://openrouter.ai/api/alpha/decisions';
const API_KEY = process.env.JEV_API_KEY ?? '';
const MODEL = process.env.JEV_DEFAULT_MODEL ?? 'typesafe/jev-1.13';

if (!API_KEY) { console.error('.env 或环境变量中缺少 JEV_API_KEY'); process.exit(1); }

const request = {
  model: MODEL,
  state: {
    user_speech: '你能跳个舞吗？跳得好我给你拍张照。',
    user_emotion: '开心',
    user_distance_cm: 120,
    environment: '客厅，地面平整，前方1.5米无遮挡',
    robot_status: {
      battery_percent: 78, current_action: 'idle', is_busy: false,
      head_yaw_deg: 0, head_pitch_deg: 0,
      arm_pose: 'shoulder=0, elbow=10, gripper=0',
      base_position_cm: '0, 0', base_heading_deg: 0, screen_expression: 'neutral'
    },
    hardware: { camera: true, speaker: true, mobility: true, arm: true },
    safety_flags: { emergency_stop: false, human_too_close: false, obstacle_detected: false },
    conversation_history: [
      { role: 'user', text: '你好' },
      { role: 'robot', text: '你好，我是小机器人。' }
    ]
  },
  questions: {
    intent: {
      type: 'choice',
      instructions: '根据 `user_speech`、`user_emotion` 和 `conversation_history`，判断用户希望机器人执行的主要动作。用户提到拍照等附带词时不要被带偏，只判断用户明确要求的主动作。',
      criteria: {
        greet: '用户打招呼、问好',
        stop: '用户要求停止、暂停、别动',
        fetch: '要求机器人拿取、抓取、递出物品',
        joke: '用户要求讲笑话、逗乐',
        dance: '用户要求跳舞、表演舞蹈',
        sing: '用户要求唱歌、演唱',
        take_photo: '用户明确要求机器人拍照',
        follow: '用户要求机器人跟随自己',
        unknown: '无法判断用户意图'
      }
    },
    safe_to_execute: {
      type: 'noul',
      instructions: '结合 `robot_status`、`hardware`、`safety_flags` 和 `environment`，判断机器人当前是否能够安全执行 `intent` 所选的动作。',
      criteria: { true: '环境安全，机器人状态与硬件均允许执行该动作', false: '存在安全风险，或机器人当前无法执行该动作' }
    },
    response_urgency: {
      type: 'score',
      instructions: '根据 `user_speech` 判断机器人应以多快的速度作出反应。',
      criteria: ['可以稍后回应', '正常速度回应', '立即回应']
    },
    needs_clarification: {
      type: 'noul',
      instructions: '判断当前信息是否足以确定用户意图。若 `user_speech` 含糊、多义、缺少必要参数，则答案为是。',
      criteria: { true: '信息不足或含糊，需要向用户反问确认', false: '信息充分，可以直接执行' }
    },
    emotion: {
      type: 'choice',
      instructions: '根据 `user_speech` 的语气和 `user_emotion`，判断机器人应以什么情绪回应。',
      criteria: {
        neutral: '中性、平静的日常回应', happy: '愉快、亲切的回应',
        excited: '兴奋、充满活力的回应', curious: '好奇、想了解更多的回应',
        confused: '困惑、不确定该如何理解', sad: '低落、安慰性的回应',
        angry: '生气或不满的回应', sleepy: '困倦、慢悠悠的回应', focus: '专注、认真执行的回应'
      }
    }
  }
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30000);
try {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify(request),
    signal: controller.signal
  });
  const text = await res.text();
  console.log('HTTP', res.status);
  if (!res.ok) { console.error(text.slice(0, 800)); process.exit(1); }
  const data = JSON.parse(text);
  console.log('\n=== model ===');
  console.log(data.model, '| provider:', data.provider);
  console.log('\n=== answers ===');
  for (const [key, a] of Object.entries(data.answers)) {
    if (a.type === 'choice') {
      const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 4)
        .map(function (e) { return e[0] + '=' + e[1]; }).join(', ');
      console.log('  ' + key + ' [choice] -> ' + a.choice + '  confidence=' + a.confidence);
      console.log('      top: ' + top);
    } else if (a.type === 'noul') {
      console.log('  ' + key + ' [noul]   -> ' + a.noul);
    } else if (a.type === 'score') {
      console.log('  ' + key + ' [score]  -> ' + a.score + '  confidence=' + a.confidence);
    }
  }
  console.log('\n=== usage ===');
  console.log(JSON.stringify(data.usage));
} catch (err) {
  console.error('failed:', err instanceof Error ? err.message : err);
  process.exit(1);
} finally { clearTimeout(timer); }
