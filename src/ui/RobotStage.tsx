import { useMemo, useState } from 'react';
import { ACTION_MAP } from '../domain/actionLibrary';
import { ROBOT_SPEC } from '../domain/robotSpec';
import type { Pose, ScreenExpression } from '../domain/types';
import type { EngineSnapshot } from '../engine/simulationEngine';

interface RobotStageProps {
  snapshot: EngineSnapshot;
  scale?: number;
}

const EXPR_FACE: Record<
  ScreenExpression,
  { eyes: string; mouth: string; accent: string; label: string }
> = {
  neutral: { eyes: 'M -18,-6 q 9,-7 18,0', mouth: 'M -14,20 q 14,7 28,0', accent: '#5eead4', label: '平静' },
  happy: { eyes: 'M -18,-6 q 9,-9 18,0', mouth: 'M -16,17 q 16,12 32,0', accent: '#5eead4', label: '开心' },
  joy: { eyes: 'M -19,-8 q 9,-11 19,0 M 1,-8 q 9,-11 19,0', mouth: 'M -18,14 q 18,20 36,0', accent: '#fbbf24', label: '兴奋' },
  sad: { eyes: 'M -18,-2 q 9,5 18,0', mouth: 'M -14,23 q 14,-8 28,0', accent: '#60a5fa', label: '难过' },
  angry: { eyes: 'M -19,-9 l 17,6 M 19,-9 l -17,6', mouth: 'M -15,23 q 15,-9 30,0', accent: '#f87171', label: '生气' },
  surprise: { eyes: 'M -16,-4 a 6,6 0 1,0 0.1,0 M 16,-4 a 6,6 0 1,0 0.1,0', mouth: 'M -7,20 a 7,7 0 1,0 0.1,0', accent: '#fbbf24', label: '惊讶' },
  sleepy: { eyes: 'M -18,-6 q 9,4 18,0 M 2,-6 q 9,4 18,0', mouth: 'M -9,21 a 9,5 0 1,0 0.1,0', accent: '#a78bfa', label: '困倦' },
  focus: { eyes: 'M -19,-6 l 17,0 M 2,-6 l 17,0', mouth: 'M -13,20 h 26', accent: '#38bdf8', label: '专注' },
  heart: { eyes: 'M -12,-4 C -18,-10 -25,-2 -12,4 C 1,-2 -6,-10 -12,-4 M 12,-4 C 6,-10 -1,-2 12,4 C 25,-2 18,-10 12,-4', mouth: 'M -17,17 q 17,14 34,0', accent: '#f472b6', label: '爱心' },
  question: { eyes: 'M -18,-6 q 9,-6 18,0', mouth: 'M -8,19 a 8,6 0 1,0 0.1,0', accent: '#5eead4', label: '疑惑' },
  error: { eyes: 'M -18,-8 l 16,8 M -2,-8 l 16,8', mouth: 'M -16,24 h 32', accent: '#f87171', label: '错误' },
  loading: { eyes: 'M -18,-6 q 9,-8 18,0', mouth: 'M -14,21 q 7,6 14,0', accent: '#38bdf8', label: '思考中' },
};

const PHASE_LABEL: Record<string, string> = {
  idle: '待机',
  preparing: '准备',
  running: '执行中',
  settling: '收尾',
  stopped: '已停止',
  interrupted: '被打断',
  failed: '异常',
};

/**
 * 机器人可视化舞台。
 * 用 SVG 直接由 Pose 驱动，纯展示层，不含业务逻辑。
 */
export function RobotStage({ snapshot }: RobotStageProps) {
  const { pose, phase, currentActionId, progress, battery } = snapshot;
  const [showGrid, setShowGrid] = useState(true);

  const face = EXPR_FACE[pose.screenExpr] ?? EXPR_FACE.neutral;
  const action = currentActionId ? ACTION_MAP.get(currentActionId) : undefined;

  // 底盘位移换算为场景坐标，60px = 10cm
  const PX_PER_CM = 6;
  const sceneX = 300 - pose.baseZ * PX_PER_CM;
  const sceneY = 210 - pose.baseX * PX_PER_CM;

  const headTransform = `translate(${sceneX} ${sceneY}) rotate(${pose.baseHeading})`;
  const eyeOpacity = Math.max(0, Math.min(1, pose.eyeOpen));

  // 眨眼时用眼睑遮挡
  const lidClose = 1 - eyeOpacity;

  const statusColor = useMemo(() => {
    switch (phase) {
      case 'running':
        return '#34d399';
      case 'preparing':
        return '#fbbf24';
      case 'failed':
        return '#f87171';
      default:
        return '#64748b';
    }
  }, [phase]);

  return (
    <div className="stage">
      <div className="stage-toolbar">
        <div className="stage-status">
          <span className="dot" style={{ background: statusColor }} />
          <span>{PHASE_LABEL[phase] ?? phase}</span>
          {action && (
            <span className="stage-action">
              {action.label}
              <em>{(progress * 100).toFixed(0)}%</em>
            </span>
          )}
        </div>
        <div className="stage-battery">
          电量 <b>{battery}%</b>
          {battery < 15 && <span className="warn">低电量</span>}
        </div>
        <button className="ghost-btn" onClick={() => setShowGrid((v) => !v)}>
          {showGrid ? '隐藏网格' : '显示网格'}
        </button>
      </div>

      <svg viewBox="0 0 600 380" className="stage-svg" role="img" aria-label="机器人姿态">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0f172a" />
            <stop offset="100%" stopColor="#020617" />
          </linearGradient>
          <radialGradient id="glow" cx="50%" cy="45%" r="55%">
            <stop offset="0%" stopColor={face.accent} stopOpacity="0.25" />
            <stop offset="100%" stopColor={face.accent} stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect width="600" height="380" fill="url(#sky)" rx="14" />
        {showGrid && (
          <g opacity="0.16" stroke="#38bdf8" strokeWidth="0.5">
            {Array.from({ length: 13 }, (_, i) => (
              <line key={`v${i}`} x1={i * 50} y1="0" x2={i * 50} y2="380" />
            ))}
            {Array.from({ length: 8 }, (_, i) => (
              <line key={`h${i}`} x1="0" y1={i * 50} x2="600" y2={i * 50} />
            ))}
          </g>
        )}

        {/* 原点标记 */}
        <g opacity="0.5">
          <circle cx={300} cy={210} r="5" fill="none" stroke="#94a3b8" />
          <line x1={292} y1={210} x2={308} y2={210} stroke="#94a3b8" />
          <line x1={300} y1={202} x2={300} y2={218} stroke="#94a3b8" />
          <text x={308} y={206} fill="#94a3b8" fontSize="9">
            原点 (0,0)
          </text>
        </g>

        <circle cx={sceneX} cy={sceneY} r="110" fill="url(#glow)" />

        <g transform={headTransform}>
          {/* 身体 */}
          <g transform={`rotate(${pose.bodyLean}) translate(0 34)`}>
            <rect x="-38" y="0" width="76" height="62" rx="16" fill="#1e293b" stroke="#475569" strokeWidth="1.5" />
            <rect x="-26" y="10" width="52" height="14" rx="5" fill="#0f172a" />
            <circle cx="0" cy="46" r="5" fill={face.accent} opacity="0.8" />
          </g>

          {/* 机械臂：左右对称，由 shoulder/elbow 驱动 */}
          <Arm
            side={-1}
            shoulder={pose.shoulder}
            elbow={pose.elbow}
            wrist={pose.wrist}
            gripper={pose.gripper}
            originX={-30}
            originY={40}
          />
          <Arm
            side={1}
            shoulder={pose.shoulder}
            elbow={pose.elbow}
            wrist={pose.wrist}
            gripper={pose.gripper}
            originX={30}
            originY={40}
          />

          {/* 颈部与云台 */}
          <rect x="-8" y="18" width="16" height="20" rx="5" fill="#334155" />
          <g transform={`translate(0 4) rotate(${pose.headRoll})`}>
            <g transform={`rotate(${pose.headYaw}) rotate(${pose.headPitch})`}>
              <rect x="-44" y="-46" width="88" height="72" rx="22" fill="#111827" stroke="#334155" strokeWidth="2" />
              {/* 屏幕脸 */}
              <rect x="-38" y="-40" width="76" height="60" rx="18" fill="#020617" />
              <g
                fill="none"
                stroke={face.accent}
                strokeWidth="2.6"
                strokeLinecap="round"
                opacity={0.35 + eyeOpacity * 0.65}
              >
                <path d={face.eyes} />
                <path d={face.mouth} />
              </g>
              {/* 眼睑遮挡，模拟闭眼 */}
              {lidClose > 0.02 && (
                <rect
                  x={-38}
                  y={-40}
                  width="76"
                  height={lidClose * 46}
                  rx="12"
                  fill="#020617"
                  opacity="0.92"
                />
              )}
              {/* 状态灯 */}
              <circle cx="0" cy="-46" r="3" fill={face.accent}>
                <animate
                  attributeName="opacity"
                  values={phase === 'running' ? '1;0.25;1' : '0.7'}
                  dur="1.2s"
                  repeatCount="indefinite"
                />
              </circle>
            </g>
          </g>
        </g>

        {/* 坐标读数 */}
        <g fontSize="9" fill="#64748b" fontFamily="ui-monospace, monospace">
          <text x="12" y="368">
            pos({pose.baseX.toFixed(1)}, {pose.baseZ.toFixed(1)})cm  hdg {pose.baseHeading.toFixed(1)}°
          </text>
          <text x="470" y="368">
            yaw {pose.headYaw.toFixed(1)}° pitch {pose.headPitch.toFixed(1)}°
          </text>
          <text x="470" y="20">{ROBOT_SPEC.name}</text>
        </g>
      </svg>

      <PoseReadout pose={pose} />
    </div>
  );
}

interface ArmProps {
  side: -1 | 1;
  shoulder: number;
  elbow: number;
  wrist: number;
  gripper: number;
  originX: number;
  originY: number;
}

/** 单条机械臂：肩→肘→腕三级连杆 */
function Arm({ side, shoulder, elbow, wrist, gripper, originX, originY }: ArmProps) {
  const upper = 34;
  const fore = 30;
  // 肩角：side 为 -1 时镜像
  const s1 = side * (90 - shoulder);
  const s2 = s1 + side * elbow;
  const s3 = s2 + side * wrist;

  const ex = originX + side * Math.cos((s1 * Math.PI) / 180) * upper;
  const ey = originY - Math.sin((s1 * Math.PI) / 180) * upper;
  const wx = ex + side * Math.cos((s2 * Math.PI) / 180) * fore;
  const wy = ey - Math.sin((s2 * Math.PI) / 180) * fore;
  const tx = wx + side * Math.cos((s3 * Math.PI) / 180) * 12;
  const ty = wy - Math.sin((s3 * Math.PI) / 180) * 12;

  const gap = 3 + gripper * 5;

  return (
    <g>
      <line x1={originX} y1={originY} x2={ex} y2={ey} stroke="#475569" strokeWidth="7" strokeLinecap="round" />
      <circle cx={ex} cy={ey} r="4.5" fill="#64748b" />
      <line x1={ex} y1={ey} x2={wx} y2={wy} stroke="#3f4a5a" strokeWidth="6" strokeLinecap="round" />
      <circle cx={wx} cy={wy} r="4" fill="#64748b" />
      {/* 夹爪 */}
      <g transform={`translate(${tx} ${ty}) rotate(${(s3 * 180) / Math.PI})`}>
        <line x1={-gap} y1="-5" x2={-gap} y2="5" stroke="#94a3b8" strokeWidth="2.4" strokeLinecap="round" />
        <line x1={gap} y1="-5" x2={gap} y2="5" stroke="#94a3b8" strokeWidth="2.4" strokeLinecap="round" />
      </g>
    </g>
  );
}

function PoseReadout({ pose }: { pose: Pose }) {
  const items: [string, string][] = [
    ['yaw', `${pose.headYaw.toFixed(1)}°`],
    ['pitch', `${pose.headPitch.toFixed(1)}°`],
    ['roll', `${pose.headRoll.toFixed(1)}°`],
    ['shoulder', `${pose.shoulder.toFixed(1)}°`],
    ['elbow', `${pose.elbow.toFixed(1)}°`],
    ['gripper', pose.gripper.toFixed(2)],
    ['baseX', `${pose.baseX.toFixed(1)}cm`],
    ['baseZ', `${pose.baseZ.toFixed(1)}cm`],
    ['heading', `${pose.baseHeading.toFixed(1)}°`],
    ['lean', `${pose.bodyLean.toFixed(1)}°`],
  ];
  return (
    <div className="pose-readout">
      {items.map(([k, v]) => (
        <span key={k}>
          <em>{k}</em>
          {v}
        </span>
      ))}
    </div>
  );
}
