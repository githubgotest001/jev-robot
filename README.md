# Jev 机器人指令台

用游戏模拟的方式，在 Web 页面里指挥一台桌面陪伴机器人。

指令链路：**语音转写文本 → Jev 决策模型 → 确定性动作编排 → 机器人执行**

机器人形态：云台头部 + 屏幕表情 + 双机械臂 + 移动底盘 + 声音反馈。

---

## 这不是 LLM：Jev 是什么

[Jev](https://thejevai.com/docs) 是 TypeSafe 的**非生成式决策模型**（System One model），
2026 年 9 月发布，托管在 OpenRouter 与 TypeSafe 官方 API。

关键区别——这决定了整个工程的架构：

| | 生成式 LLM | Jev |
| --- | --- | --- |
| 输出 | 文本 / JSON 字符串 | **定型值 + 概率分布** |
| 可能说错吗 | 会，可能编造 | 不会，只能从你给定的选项里选 |
| 不确定性 | 藏在文字里，看不见 | **就是返回值本身，可直接设阈值** |
| 价格 | 输入输出都计费 | $0.042/百万输入 token，**输出免费** |

所以本工程**不让 Jev 生成任何文字**。它只回答三个定型问题：

| 问题类型 | 用途 | 返回 |
| --- | --- | --- |
| `choice` | 从 ≤255 个选项中选一个 | `choice` + `probabilities` + `confidence` |
| `score` | 在 2~10 个有序档位上评分 | `score`（可落在档位之间）+ `legend` + `probabilities` + `confidence` |
| `noul` | 判断某个命题成立的概率 | `noul`（0~1），**没有独立的 confidence 字段** |

于是职责划分变成官方推荐的 *route-then-write* 模式：

```
Jev（判定）      →  用户想要什么？能不能做？要不要反问？多急？
我的代码（执行） →  这个意图对应哪串动作、说什么话术、给哪些追问按钮
```

**动作编排和话术全部由代码决定**，不依赖任何生成式输出，因此行为可预测、可测试、可调参。

---

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5173
```

开箱即用，无需任何配置或网络：默认 **Mock 模式**，
用规则近似 Jev 的输出形状，离线跑通完整链路并可开发 UI。

用语音输入法在底部输入框说话即可，也可点快捷指令或机器人回复下方的预设 choice。

---

## 一次决策问了 Jev 三个问题

全部并行评估，单次往返拿到全部答案：

| 问题 key | 类型 | 作用 |
| --- | --- | --- |
| `intent` | choice | 27 个受支持意图中选一个，附带完整概率分布 |
| `safe_to_execute` | noul | 安全闸门：当前能否安全执行 |
| `gesture_style` | choice | 表现风格：gentle / normal / lively / solemn |

### 为什么只有三个

官方文档明确要求各问题的含义**彼此独立**，不做重复提问：

- **`intent` 的 confidence 已经表达了不确定性**，无需再单独问一次"信息是否充分"。
  官方也特别指出 noul ≈ 0.5 表示"不知道"，应作为第三种结果处理——
  这个职责由 intent 的概率分布天然承担。
- **情绪不再单独提问**：27 个意图里大部分已隐含情绪（greet→happy、dance→joy），
  单独再问一次是浪费决策预算。
- **`gesture_style` 与 `intent` 正交**：同一个意图可以有不同表现力，
  例如"跳舞"可以轻快也可以夸张。它真正参与调度——
  gentle 缩放 0.8、lively 放大 1.15，影响动作时长与表情。

情绪由 `意图 + 风格` 在代码中推导，不消耗额外决策。

---

## 决策策略

Jev 的 `confidence` 衡量的是**概率分布的集中度，不代表正确率**。
按官方建议，阈值由应用按自身风险自定。配置页可实时调整：

```
safe_to_execute   < 0.60   →  安全闸门拦截，只做拒绝回应
intent confidence < 0.45   →  按未知意图处理，给引导选项
intent confidence < 0.70   →  置信度中等，反问确认
intent confidence ≥ 0.70   →  直接执行
```

### 三种提问类型的判读方式

**noul ≈ 0.5 是"我不知道"，要当成第三种结果处理。**
不是 0 也不是 1 时，说明 Jev 在两个方向间摇摆——此时应当反问，而不是硬选。

**confidence 高不代表对。** 一个模型把全部权重压在一个选项上，confidence 就是 1.0。
是否选对了，取决于你的 `criteria` 描述写得好不好。

**score 的 score 是概率加权平均**，可落在档位之间。

---

## 接入真实 Jev

### 配置方式：`.env`（推荐）

项目根目录已有 `.env`（已加入 `.gitignore`，不会被提交），把密钥填进去即可：

```
JEV_API_KEY=sk-or-v1-你的密钥
JEV_UPSTREAM=https://openrouter.ai/api/alpha/decisions
JEV_DEFAULT_MODEL=typesafe/jev-1.13
JEV_PROXY_PORT=8787
```

填完后启动两个进程：

```bash
npm run proxy       # 终端 1：读 .env，监听 8787
npm run dev         # 终端 2：前端，启动时自动向代理拉取配置
```

前端启动时会向代理的 `/jev/config` 请求密钥、端点、模型，
**检测到有效密钥后自动切换到真实模式**，界面上无需任何设置。

`.env` 是唯一真源——浏览器不落盘密钥，也不需要手工填写。
配置页的「从 .env 加载」按钮可在代理启动后手动重新拉取。

### 端点对照

| 服务 | 端点 | 模型名 | key 前缀 |
| --- | --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` | `sk-or-v1-` |
| TypeSafe 官方 | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `sk_` |
| 本地代理 | `http://localhost:8787/jev/decisions` | 同上 | 服务端持有 |

换服务商只需改 `.env` 里的 `JEV_UPSTREAM` 与 `JEV_API_KEY`，前端零改动。

### 不用代理的直连方式

配置页填入 API Key 即可，但**密钥会出现在浏览器里，仅供本地调试**。

### 代理端点

| 端点 | 用途 |
| --- | --- |
| `POST /jev/decisions` | 透传转发到上游 Jev，响应原样返回 |
| `GET /jev/config` | 下发 `.env` 中的密钥、端点、模型 |
| `GET /health` | 健康检查，查看是否已加载密钥 |

代理在转发前会校验请求体（state / questions 结构、问题类型、score 档位数量），
不合规直接返回 422，避免无谓的计费请求。

> `/jev/config` 会下发密钥，仅适用于绑定 localhost 的本地开发。
> 部署到公网前务必加上鉴权或移除该端点。

### 验证脚本

```bash
node verify-jev.mjs
```

直接用 `.env` 里的配置跑一遍三个问题，打印真实判定与概率分布。
密钥只从 `.env` 读取，不会打印到输出。

---

## 界面说明

三栏布局：

| 区域 | 内容 |
| --- | --- |
| 左 · 舞台 | SVG 实时姿态：头部、机械臂、夹爪、底盘、表情、坐标网格，附姿态读数 |
| 中 · 对话 | 语音输入、快捷指令、预设 choice、决策路径、动作编排标签 |
| 右 · Jev 判定 | **choice 概率条、noul 刻度、score 图例、token 用量**，下方是时间线与动作库 |

右侧判定面板是理解 Jev 决策的关键——它把概率分布直接摊开，
可以清楚看到每个选项分到多少权重，而不是只看到一个孤零零的结论。

配置页提供硬件开关与安全标志开关，可用来演示安全闸门：
关掉「移动底盘」再让机器人过来，`safe_to_execute` 的 noul 会掉到 0.12，
机器人只做拒绝回应而不执行动作。

---

## 动作库

29 个预置动作，按执行器分组：头部 / 屏幕 / 机械臂 / 底盘 / 声音 / 身体。

点击动作库里的任意按钮可直接播放，绕过决策层，用于单独调参。

### 新增动作

只往 `src/domain/actionLibrary.ts` 的 `ACTION_LIBRARY` 追加对象，引擎与 Jev 侧零改动：

```ts
{
  id: 'arm.salute',
  label: '敬礼',
  aliases: ['敬礼', 'salute'],
  description: '右手举至额前行礼。',   // 喂给代码路由，不进 Jev prompt
  actuators: ['arm', 'head'],
  durationMs: 1200,
  interruptible: false,
  priority: 60,
  params: [ /* 参数 schema */ ],
  keyframes: [
    { t: 0,   pose: { shoulder: 0,  elbow: 10 } },
    { t: 0.4, pose: { shoulder: 110, elbow: 95, headPitch: -5 } },
    { t: 1,   pose: { shoulder: 0,  elbow: 10 } },
  ],
  emotion: 'neutral',
}
```

### 新增意图

1. 在 `src/jev/robotQuestions.ts` 的 `ROBOT_INTENTS` 加枚举值
2. 在 `buildIntentQuestion()` 的 `criteria` 加中文描述（**这段会发给 Jev，语义必须写全**）
3. 在 `src/jev/actionRouter.ts` 的 `PLANS` 加对应编排与话术

---

## 架构

```
src/
├── domain/       动作库 Schema、机器人规格与姿态定义
│   ├── types.ts            领域类型
│   ├── robotSpec.ts        铭牌、物理行程、初始姿态
│   └── actionLibrary.ts    29 个预置动作 + 给 Jev 的动作说明
├── jev/          决策层
│   ├── jevTypes.ts         Jev 协议类型（choice / score / noul）
│   ├── jevClient.ts        HTTP + 超时 + 429/529 指数退避重试
│   ├── robotQuestions.ts   27 意图枚举 + 五问题定义 + state 组装
│   ├── actionRouter.ts     意图 → 动作编排 / 话术 / 追问选项
│   ├── jevProvider.ts      判定 → 决策路径分流
│   ├── mockJev.ts          离线模拟，形状与真实 Jev 一致
│   └── config.ts           接入点、阈值策略、state 输入
├── engine/       执行层
│   ├── poseMath.ts          关键帧插值、参数化解算、物理限位
│   └── simulationEngine.ts  串行队列、打断、时间线
├── ui/           展示层
└── App.tsx       编排各层
server/
└── proxy.mjs     可选代理，透传转发，密钥留在服务端
```

分层单向依赖：`UI → App → Engine → Domain`，`App → Jev`，Jev 不反向依赖任何层。

### 执行引擎要点

- **帧驱动**：外层 `requestAnimationFrame` 调 `tick()`，引擎内部不开定时器
- **串行单槽**：动作按队列依次执行，动作间的 `delayMs` 在槽内等待
- **按真实时间插值**：关键帧 `t` 不等分时也能正确还原节奏（用二分查找分段插值）
- **平滑衔接**：动作入场用 easeOut 消化与上一动作终态的偏差，终态严格等于末关键帧
- **参数化解算**：移动/转向的目标位姿由 params 决定，按进度插值到位
- **物理限位**：所有姿态经 `clampPose` 收敛到物理行程内

---

## 防御性设计

- Jev 响应一律经 `asChoiceAnswer` / `asNoulAnswer` / `asScoreAnswer` 收敛，字段缺失给安全默认
- 意图 choice 收敛到受支持枚举，未知一律降为 `unknown`
- 请求带超时与指数退避重试，429/529 自动重试
- Jev 不可用时降级到本地规则编排，机器人不会"哑火"
- 硬件缺失时自动剔除对应动作，并给出替代话术
- 低电量（<15%）自动禁用底盘动作
- 动作编排保证至少含一个动作，避免机器人无反应
- 配置读取失败回落默认值，localStorage 不可用时静默降级

---

## 已知边界

- 意图到动作的映射是硬编码的规则表。Jev 只做意图判定，不生成动作编排——
  这是非生成式模型的固有约束，也是可预测性的来源。
- 若需要开放式的话术生成，可在 Jev 判定之后再串一个生成式 LLM，
  输入是已确定的 intent + emotion + 动作编排，输出才是自然语言。
- Jev 只接受文本 / JSON / 文本数组，不支持图像、音频、视频输入。
