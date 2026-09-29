import type { Pose } from './types';

/** 机器人铭牌与物理规格 */
export const ROBOT_SPEC = {
  name: 'JEV-One',
  model: '桌面陪伴机器人 v0.1',
  /** 云台水平行程 */
  headYawRange: [-90, 90] as const,
  /** 云台俯仰行程 */
  headPitchRange: [-45, 45] as const,
  /** 底盘单步最大位移（厘米），超出视为越界 */
  baseStepLimitCm: 120,
  /** 电池百分比，初始值 */
  battery: 87,
  /** 单次移动动作的耗电百分比 */
  batteryCostPerMove: 2,
  /** 底盘动作冲突组名 */
  conflictGroupBase: 'base',
} as const;

/** 初始待机姿态 */
export const NEUTRAL_POSE: Pose = {
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  screenExpr: 'neutral',
  eyeOpen: 1,
  shoulder: 0,
  elbow: 10,
  wrist: 0,
  gripper: 0,
  baseX: 0,
  baseZ: 0,
  baseHeading: 0,
  bodyLean: 0,
};

export function clonePose(pose: Pose): Pose {
  return { ...pose };
}