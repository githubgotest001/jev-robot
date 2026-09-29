/**
 * 领域层：与框架无关的纯类型定义。
 * APP -> ENGINE -> JEV 分层，上层只依赖此处的类型，不越层访问实现。
 */

/** 执行器种类：对应机器人物理部件，用于互斥判定与可视化分组 */
export type ActuatorKind =
  | 'head'
  | 'screen'
  | 'arm'
  | 'base'
  | 'audio'
  | 'body';

/** 屏幕表情枚举 */
export type ScreenExpression =
  | 'neutral'
  | 'happy'
  | 'joy'
  | 'sad'
  | 'angry'
  | 'surprise'
  | 'sleepy'
  | 'focus'
  | 'heart'
  | 'question'
  | 'error'
  | 'loading';

/** 情绪标签：贯穿对话、表情与动作选择 */
export type Emotion =
  | 'neutral'
  | 'happy'
  | 'joy'
  | 'excited'
  | 'curious'
  | 'confused'
  | 'sad'
  | 'angry'
  | 'sleepy'
  | 'focus';

/** 动作参数定义 */
export interface ActionParam {
  name: string;
  /** 参数用途说明，会拼接进给 LLM 的动作库描述 */
  description: string;
  type: 'number' | 'enum' | 'boolean';
  required: boolean;
  default?: number | string | boolean;
  min?: number;
  max?: number;
  options?: string[];
}

/**
 * 关键帧：t 为该动作内的归一化时间 [0,1]。
 * pose 中未出现的字段保持继承上一关键帧的值。
 */
export interface Keyframe {
  t: number;
  pose: Partial<Pose>;
}

/** 机器人瞬时姿态，字段全部为物理量纲 */
export interface Pose {
  /** 云台水平角，度，范围 [-90, 90] */
  headYaw: number;
  /** 云台俯仰角，度，范围 [-45, 45] */
  headPitch: number;
  /** 头部侧倾（歪头），度，范围 [-30, 30] */
  headRoll: number;
  /** 屏幕表情 */
  screenExpr: ScreenExpression;
  /** 眼睛睁开程度，0 闭合 ~ 1 全开 */
  eyeOpen: number;
  /** 肩关节角，度 */
  shoulder: number;
  /** 肘关节角，度 */
  elbow: number;
  /** 腕关节角，度 */
  wrist: number;
  /** 夹爪闭合度，0 打开 ~ 1 闭合 */
  gripper: number;
  /** 底盘前后位移，厘米 */
  baseX: number;
  /** 底盘左右位移，厘米 */
  baseZ: number;
  /** 底盘朝向，度 */
  baseHeading: number;
  /** 身体前倾/后仰，度 */
  bodyLean: number;
}

/** 预置动作定义 */
export interface RobotAction {
  id: string;
  /** 中文名称，直接喂给 LLM */
  label: string;
  /** 同义词列表，用于 Mock 引擎关键词命中 */
  aliases: string[];
  /** 给 LLM 看的一句话语义描述 */
  description: string;
  /** 占用哪些执行器 */
  actuators: ActuatorKind[];
  /** 基础时长（毫秒），可被 durationScale 缩放 */
  durationMs: number;
  /** 执行中是否允许被打断 */
  interruptible: boolean;
  /** 优先级 0~100，数值越大越不可被打断 */
  priority: number;
  /** 互斥组：同组动作不能并行（如两个底盘移动） */
  conflictGroup?: string;
  /** 参数定义 */
  params: ActionParam[];
  /** 关键帧序列，至少含 t=0 与 t=1 */
  keyframes: Keyframe[];
  /** 该动作自带的情绪倾向，供 Mock 引擎参考 */
  emotion?: Emotion;
}

/** 参数值的合法类型 */
export type ParamValue = number | string | boolean;

/** 动作参数字典 */
export type ParamMap = Record<string, ParamValue>;

/** 决策层下达的一次动作调用 */
export interface PlannedAction {
  actionId: string;
  params?: ParamMap;
  /** 相对上一动作完成后的延迟（毫秒） */
  delayMs?: number;
  /** 时长缩放系数，1 为原速 */
  durationScale?: number;
}

/** 预设追问选项 */
export interface QuickChoice {
  id: string;
  label: string;
  /** 点击后作为用户输入发送的文本 */
  value: string;
}

/** JEV 决策模型的统一输出契约 */
export interface JevDecision {
  /** 机器人回复文本（用于 TTS） */
  utterance: string;
  emotion: Emotion;
  /** 意图标签，用于调试与统计 */
  intent: string;
  /** 置信度 0~1 */
  confidence: number;
  /** 动作编排序列 */
  actions: PlannedAction[];
  /** 预置追问选项 */
  choices: QuickChoice[];
  /** 决策依据，仅调试展示 */
  reasoning?: string;
}

/** 对话消息 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'robot' | 'system';
  content: string;
  emotion?: Emotion;
  /** 该轮决策产生的动作 id 列表 */
  actionIds?: string[];
  choices?: QuickChoice[];
  /** 决策耗时（毫秒） */
  latencyMs?: number;
  /** 决策依据，仅调试展示 */
  reasoning?: string;
  source?: 'user' | 'choice' | 'preset';
  timestamp: number;
}

/** 动作执行状态机的状态 */
export type ExecutionPhase =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'settling'
  | 'stopped'
  | 'interrupted'
  | 'failed';
