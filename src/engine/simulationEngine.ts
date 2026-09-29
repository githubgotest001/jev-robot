import { ACTION_MAP } from '../domain/actionLibrary';
import { NEUTRAL_POSE, ROBOT_SPEC, clonePose } from '../domain/robotSpec';
import type {
  ExecutionPhase,
  ParamMap,
  ParamValue,
  Pose,
  PlannedAction,
  RobotAction,
} from '../domain/types';
import {
  clampPose,
  lerpAngleTo,
  normalizeAngle,
  resolveKeyframes,
  resolveTargetPose,
  samplePose,
} from './poseMath';
import type { ResolvedFrame } from './poseMath';

export interface TimelineEvent {
  id: string;
  actionId: string;
  label: string;
  /** 触发时的姿态快照，用于时间线回看 */
  poseAtStart: Pose;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'interrupted' | 'failed';
  params?: ParamMap;
}

export interface EngineSnapshot {
  pose: Pose;
  phase: ExecutionPhase;
  currentActionId: string | null;
  /** 当前动作进度 0~1 */
  progress: number;
  battery: number;
  timeline: TimelineEvent[];
  busy: boolean;
}

interface ActiveTask {
  event: TimelineEvent;
  action: RobotAction;
  resolved: ResolvedFrame[];
  fromPose: Pose;
  /** 参数化动作解算出的目标位姿（绝对值） */
  targetPose: Partial<Pose>;
  startTime: number;
  delayMs: number;
  durationMs: number;
  started: boolean;
}

type Listener = (snapshot: EngineSnapshot) => void;

let idSeed = 0;
function nextId(prefix: string): string {
  idSeed += 1;
  return `${prefix}-${idSeed}`;
}

/** 补齐动作参数的默认值 */
function withDefaults(action: RobotAction, params?: ParamMap): ParamMap {
  const out: ParamMap = {};
  for (const p of action.params) {
    if (p.default !== undefined) {
      out[p.name] = p.default as ParamValue;
    }
  }
  return { ...out, ...params };
}

const MAX_TIMELINE = 60;

/**
 * 机器人动作仿真引擎。
 * 设计要点：
 * - 帧驱动：外层 requestAnimationFrame 调 tick，内部不自行开定时器。
 * - 单一动作槽：串行执行，delay 在槽内等待，形成自然停顿。
 * - 参数化解算：移动/转向类动作的目标位姿由 params 决定，按进度插值到位。
 * - 可打断：abortAll 为紧急停止，普通动作可被更高优先级打断。
 */
/**
 * 抢占策略：决定新编排到达时如何对待队列里已有的动作。
 *
 * 上一版只有 queue（全部追加），导致"停下"这种高优先级指令
 * 会被排到正在执行的 arm.dance 之后才生效——对一个能移动的机器人，
 * "停下"必须立刻打断，而不是等动作播完。
 * RobotAction 的 interruptible / priority 字段此前在引擎里零引用，
 * 现在真正参与调度。
 */
export type EnqueueMode = 'queue' | 'preempt';

/** 编排入队 */
export class SimulationEngine {
  private pose: Pose = clonePose(NEUTRAL_POSE);
  private phase: ExecutionPhase = 'idle';
  private battery: number = ROBOT_SPEC.battery;
  private timeline: TimelineEvent[] = [];
  private queue: PlannedAction[] = [];
  private current: ActiveTask | null = null;
  private listeners = new Set<Listener>();
  private lastEmit = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  getSnapshot(): EngineSnapshot {
    const now = performance.now();
    return {
      pose: clonePose(this.pose),
      phase: this.phase,
      currentActionId: this.current?.started ? this.current.action.id : null,
      progress:
        this.current?.started && this.current.durationMs > 0
          ? Math.min(1, (now - this.current.startTime) / this.current.durationMs)
          : 0,
      battery: Math.round(this.battery),
      timeline: this.timeline.slice(),
      busy: this.queue.length > 0 || this.current !== null,
    };
  }

  /**
   * 编排一串动作。
   *
   * mode = 'preempt' 是紧急语义：停止指令必须无条件生效。
   * 它绕过当前动作的 interruptible 标记——标记表达的是"这个动作中途停掉
   * 会不会姿态突兀"，而不是"能不能拒绝一个急停"。对能移动的底盘，
   * 让急停排队等前面的动作播完是安全问题。
   *
   * mode = 'queue' 是普通语义：追加到队尾。但若新编排的优先级高于
   * 当前动作且当前动作可打断，则就地抢占——这样 priority 与 interruptible
   * 才真正参与调度，而不是只写在动作库里当装饰。
   */
  enqueue(actions: PlannedAction[], mode: EnqueueMode = 'queue'): void {
    if (actions.length === 0) return;

    if (mode === 'preempt') {
      this.queue = [];
      if (this.current) this.finishCurrent('interrupted');
      this.phase = 'preparing';
      this.queue.push(...actions);
      return;
    }

    if (this.current && this.canPreemptWith(actions)) {
      this.queue = [];
      this.finishCurrent('interrupted');
      this.phase = 'preparing';
    }

    this.queue.push(...actions);
    if (this.phase === 'idle') this.phase = 'preparing';
  }

  /** 新编排是否足以打断当前动作：自身优先级更高，且当前动作允许被打断 */
  private canPreemptWith(actions: PlannedAction[]): boolean {
    if (!this.current || !this.current.action.interruptible) return false;
    const incoming = actions
      .map((a) => ACTION_MAP.get(a.actionId))
      .reduce((max, a) => Math.max(max, a?.priority ?? 0), 0);
    return incoming > this.current.action.priority;
  }

  /** 紧急停止：清空队列、中止当前动作并回到安全姿态 */
  abortAll(): void {
    this.queue = [];
    if (this.current) this.finishCurrent('interrupted');
    this.pose = clampPose({
      ...this.pose,
      shoulder: 0,
      elbow: 10,
      wrist: 0,
      headPitch: 0,
      headRoll: 0,
    });
    this.phase = 'stopped';
    this.emit();
  }

  reset(): void {
    this.queue = [];
    this.finishCurrent('interrupted');
    this.pose = clonePose(NEUTRAL_POSE);
    this.battery = ROBOT_SPEC.battery;
    this.timeline = [];
    this.phase = 'idle';
    this.emit();
  }

  clearTimeline(): void {
    this.timeline = [];
    this.emit();
  }

  /** 每帧调用 */
  tick(now: number): void {
    this.drainQueue(now);
    const task = this.current;
    if (!task) {
      if (this.phase === 'settling' && this.queue.length === 0) {
        this.phase = 'idle';
        this.emitIfDue(now);
      }
      return;
    }

    if (!task.started) {
      if (now >= task.startTime + task.delayMs) {
        task.started = true;
        this.phase = 'running';
      } else {
        this.emitIfDue(now);
        return;
      }
    }

    const p = task.durationMs > 0 ? Math.min(1, (now - task.startTime) / task.durationMs) : 1;
    this.pose = clampPose(this.sampleTask(task, p));

    if (p >= 1) {
      this.pose = clampPose(this.sampleTask(task, 1));
      this.finishCurrent('done');
      if (
        task.action.actuators.includes('base') &&
        task.action.id !== 'base.stop' &&
        task.action.id !== 'base.return_home'
      ) {
        this.battery = Math.max(0, this.battery - ROBOT_SPEC.batteryCostPerMove);
      }
      this.phase = this.queue.length > 0 ? 'preparing' : 'settling';
    }

    this.emitIfDue(now);
  }

  /** 关键帧采样 + 目标位姿混合 */
  private sampleTask(task: ActiveTask, p: number): Pose {
    const sampled = samplePose(task.resolved, p, task.fromPose);
    const target = task.targetPose as Partial<Record<keyof Pose, unknown>>;
    const from = task.fromPose as unknown as Record<keyof Pose, unknown>;
    const out = sampled as unknown as Record<keyof Pose, unknown>;

    for (const key of Object.keys(target) as (keyof Pose)[]) {
      const to = target[key];
      const start = from[key];
      if (typeof to === 'number' && typeof start === 'number') {
        out[key] =
          key === 'baseHeading'
            ? lerpAngleTo(start, to, p)
            : start + (to - start) * p;
      } else if (typeof to === 'string' && typeof start === 'string') {
        // 表情做阶跃切换，中点为界
        out[key] = p >= 0.5 ? to : start;
      }
    }
    return sampled;
  }

  private finishCurrent(status: TimelineEvent['status']): void {
    if (!this.current) return;
    this.current.event.status = status;
    this.current.event.endedAt = performance.now();
    this.current = null;
  }

  private drainQueue(now: number): void {
    if (this.current || this.queue.length === 0) return;
    const planned = this.queue.shift()!;
    const action = ACTION_MAP.get(planned.actionId);

    if (!action) {
      // 未知动作：记录失败并跳过，不阻断后续编排
      this.timeline.push({
        id: nextId('ev'),
        actionId: planned.actionId,
        label: `未知动作 ${planned.actionId}`,
        poseAtStart: clonePose(this.pose),
        startedAt: now,
        status: 'failed',
      });
      this.trimTimeline();
      return;
    }

    const params = withDefaults(action, planned.params);
    const delayMs = Math.max(0, Math.min(10000, planned.delayMs ?? 0));

    const event: TimelineEvent = {
      id: nextId('ev'),
      actionId: action.id,
      label: action.label,
      poseAtStart: clonePose(this.pose),
      startedAt: now,
      status: 'running',
      params,
    };
    this.timeline.push(event);
    this.trimTimeline();

    this.current = {
      event,
      action,
      resolved: resolveKeyframes(action),
      fromPose: clonePose(this.pose),
      targetPose: resolveTargetPose(action, params, this.pose),
      startTime: now,
      delayMs,
      durationMs: Math.max(120, action.durationMs * (planned.durationScale ?? 1)),
      started: delayMs === 0,
    };

    if (!this.current.started) this.phase = 'preparing';
  }

  private trimTimeline(): void {
    if (this.timeline.length > MAX_TIMELINE) this.timeline.shift();
  }

  private emitIfDue(now: number): void {
    // 限制推送频率，避免高频重渲染
    if (now - this.lastEmit < 32) return;
    this.lastEmit = now;
    this.emit();
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) fn(snap);
  }
}

export { normalizeAngle };
