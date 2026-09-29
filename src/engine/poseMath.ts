import { ROBOT_SPEC, NEUTRAL_POSE } from '../domain/robotSpec';
import type { Keyframe, ParamMap, Pose, RobotAction } from '../domain/types';

const NUMERIC_KEYS = [
  'headYaw',
  'headPitch',
  'headRoll',
  'eyeOpen',
  'shoulder',
  'elbow',
  'wrist',
  'gripper',
  'baseX',
  'baseZ',
  'baseHeading',
  'bodyLean',
] as const;

type NumericKey = (typeof NUMERIC_KEYS)[number];

/** 角度归一化到 [-180, 180] */
export function normalizeAngle(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** 线性插值 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 平滑缓动，避免机械感 */
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** 出场缓动：起步快、收尾平顺 */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** 动作入场的衔接窗口，占单次动作时长的比例 */
const SETTLE_WINDOW = 0.25;

/** 角度插值走最短路径 */
function lerpAngle(a: number, b: number, t: number): number {
  return lerpAngleTo(a, b, t);
}

/** 从 from 角度朝 to 角度插值 t，路径最短 */
export function lerpAngleTo(from: number, to: number, t: number): number {
  const diff = normalizeAngle(to - from);
  return normalizeAngle(from + diff * t);
}

/** 一帧已解析的关键帧：姿态 + 该帧的真实时间位置 */
export interface ResolvedFrame {
  /** 归一化时间 [0,1]，取自动作定义中的 t */
  t: number;
  /** 该时刻的完整姿态（已继承前序关键帧的未指定字段） */
  pose: Pose;
}

/**
 * 把动作的关键帧展开为带时间戳的姿态序列。
 *
 * 规则：
 * - 按 t 升序排序；
 * - 每个关键帧的 pose 继承前一个关键帧的累积值，缺失字段保持不变；
 * - 强制补齐 t=0 与 t=1 两端，保证采样区间闭合。
 */
export function resolveKeyframes(action: RobotAction): ResolvedFrame[] {
  const frames = [...action.keyframes].sort((a, b) => a.t - b.t);
  const out: ResolvedFrame[] = [];
  let acc: Pose = { ...NEUTRAL_POSE };

  for (const frame of frames) {
    const next: Pose = { ...acc };
    for (const key of NUMERIC_KEYS) {
      const v = frame.pose[key as keyof Pose];
      if (typeof v === 'number' && Number.isFinite(v)) {
        next[key as NumericKey] = v;
      }
    }
    if (frame.pose.screenExpr) {
      next.screenExpr = frame.pose.screenExpr;
    }
    acc = next;
    out.push({ t: Math.min(1, Math.max(0, frame.t)), pose: next });
  }

  // 补齐边界：首帧必须落在 t=0，末帧必须落在 t=1
  if (out.length === 0) return [{ t: 0, pose: { ...NEUTRAL_POSE } }, { t: 1, pose: { ...NEUTRAL_POSE } }];
  if (out[0].t > 0) out.unshift({ t: 0, pose: { ...out[0].pose } });
  const last = out[out.length - 1];
  if (last.t < 1) out.push({ t: 1, pose: { ...last.pose } });

  return out;
}

/** 二分查找 p 所处的关键帧区间 */
function findSpan(frames: ResolvedFrame[], p: number): [number, number, number] {
  const n = frames.length;
  if (n < 2) return [0, 0, 0];
  if (p <= frames[0].t) return [0, 1, 0];
  if (p >= frames[n - 1].t) return [n - 2, n - 1, 1];

  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= p) lo = mid;
    else hi = mid;
  }
  const span = frames[hi].t - frames[lo].t;
  const local = span > 0 ? (p - frames[lo].t) / span : 0;
  return [lo, hi, Math.min(1, Math.max(0, local))];
}

/**
 * 在动作进度 p∈[0,1] 处采样姿态。
 *
 * 插值依据关键帧的真实时间戳 t，而非等分索引——动作库里的 t 通常不等分
 * （如 0 / 0.3 / 0.55 / 0.8 / 1），等分会扭曲动作节奏。
 *
 * fromPose 是动作开始瞬间机器人的真实姿态。若它与首关键帧存在偏差
 * （例如上一个动作把手臂留在了半空），用 easeOut 在动作前段平滑消化这段偏差，
 * 既避免姿态跳变，又保证动作终态严格等于末关键帧定义。
 */
export function samplePose(frames: ResolvedFrame[], p: number, fromPose: Pose): Pose {
  if (frames.length === 0) return { ...fromPose };

  const clamped = Math.min(1, Math.max(0, p));
  const [i, j, local] = findSpan(frames, clamped);
  const eased = easeInOut(local);

  const a = frames[i].pose;
  const b = frames[j].pose;
  const out: Pose = { ...a };

  // 入场衔接权重：动作前段消化偏差，之后完全交给关键帧
  const settle = clamped >= SETTLE_WINDOW ? 1 : 1 - clamped / SETTLE_WINDOW;
  const w = easeOut(settle);

  for (const key of NUMERIC_KEYS) {
    const start = fromPose[key as NumericKey];
    const target = lerp(a[key as NumericKey], b[key as NumericKey], eased);
    if (key === 'baseHeading') {
      out[key as NumericKey] = lerpAngle(start, target, w);
    } else {
      out[key as NumericKey] = start + (target - start) * w;
    }
  }

  // 表情做阶跃切换，抵达下一帧时才变化
  out.screenExpr = local < 1 ? a.screenExpr : b.screenExpr;
  return out;
}

/**
 * 计算参数化动作（移动/转向）的目标姿态。
 * 这类动作的关键帧只表达节奏，位移量由 params 决定。
 */
export function resolveTargetPose(
  action: RobotAction,
  params: ParamMap,
  fromPose: Pose,
): Partial<Pose> {
  const out: Partial<Pose> = {};

  if (action.id === 'base.move') {
    const dir = String(params.direction ?? 'forward');
    const dist = clampNumber(Number(params.distanceCm ?? 40), 5, ROBOT_SPEC.baseStepLimitCm);
    // 底盘位移在世界坐标下累加，转向后 forward 的世界方向随之改变
    const headingRad = (fromPose.baseHeading * Math.PI) / 180;
    const fx = Math.sin(headingRad);
    const fz = Math.cos(headingRad);
    let dx = 0;
    let dz = 0;
    if (dir === 'forward') {
      dx = fx * dist;
      dz = fz * dist;
    } else if (dir === 'backward') {
      dx = -fx * dist;
      dz = -fz * dist;
    } else if (dir === 'left') {
      dx = -fz * dist;
      dz = fx * dist;
    } else {
      dx = fz * dist;
      dz = -fx * dist;
    }
    out.baseX = fromPose.baseX + dx;
    out.baseZ = fromPose.baseZ + dz;
  }

  if (action.id === 'base.rotate') {
    const dir = String(params.direction ?? 'left');
    const angle = clampNumber(Number(params.angleDeg ?? 90), 15, 180);
    const delta = dir === 'right' ? angle : dir === 'around' ? 180 : -angle;
    out.baseHeading = normalizeAngle(fromPose.baseHeading + delta);
    // 转向时头部跟随一部分，增加自然感
    out.headYaw = clampNumber(fromPose.headYaw + delta * 0.3, ...ROBOT_SPEC.headYawRange);
  }

  if (action.id === 'base.return_home') {
    out.baseX = 0;
    out.baseZ = 0;
    out.baseHeading = 0;
    out.headYaw = 0;
  }

  if (action.id === 'base.stop') {
    out.shoulder = 0;
    out.elbow = 10;
    out.wrist = 0;
    out.headPitch = 0;
    out.headRoll = 0;
  }

  return out;
}

function clampNumber(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** 把姿态收敛到物理行程范围内，防止模型给出越界指令导致姿态错乱 */
export function clampPose(pose: Pose): Pose {
  return {
    ...pose,
    headYaw: clampNumber(pose.headYaw, ...ROBOT_SPEC.headYawRange),
    headPitch: clampNumber(pose.headPitch, ...ROBOT_SPEC.headPitchRange),
    headRoll: clampNumber(pose.headRoll, -30, 30),
    eyeOpen: clampNumber(pose.eyeOpen, 0, 1),
    gripper: clampNumber(pose.gripper, 0, 1),
    shoulder: clampNumber(pose.shoulder, -120, 120),
    elbow: clampNumber(pose.elbow, 0, 150),
    wrist: clampNumber(pose.wrist, -90, 90),
    baseHeading: normalizeAngle(pose.baseHeading),
    bodyLean: clampNumber(pose.bodyLean, -45, 45),
  };
}

export type { Keyframe };
