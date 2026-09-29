import type { RobotAction } from '../domain/types';
import type { TimelineEvent } from '../engine/simulationEngine';
import type { DecisionPolicy, JevDecisionResult } from '../jev/jevProvider';
import type { JevConfig } from '../jev/config';
import { ActionLibrary } from './ActionLibrary';
import { ConfigPanel } from './ConfigPanel';
import { JevDocsPanel } from './JevDocsPanel';
import { TradeoffPanel } from './TradeoffPanel';
import { RightPanelTabs } from './RightPanelTabs';
import type { RightTab } from './RightPanelTabs';
import { ExecutionStrip, TimelinePanel } from './TimelinePanel';
import type { DecisionState } from './TimelinePanel';

interface RightPanelProps {
  tab: RightTab;
  onTabChange: (tab: RightTab) => void;
  decision: JevDecisionResult | null;
  policy: DecisionPolicy;
  state: DecisionState;
  timeline: TimelineEvent[];
  /** 动作库直接播放，绕过决策层 */
  onPreview: (action: RobotAction) => void;
  currentActionId: string | null;
  /** 判定面板页签上的状态点颜色 */
  decisionTone: string;
  config: JevConfig;
  onConfigChange: (config: JevConfig) => void;
}

/**
 * 右列容器：顶部三个页签（Jev 判定 / 动作库 / Jev 配置）+ 常驻执行轨迹。
 *
 * 三者互不参照，合并成一列切着看，舞台因此独占左侧整列——
 * 从动作库点一个动作时，机器人画面始终在视野里，不需要来回切页签。
 */
export function RightPanel({
  tab,
  onTabChange,
  decision,
  policy,
  state,
  timeline,
  onPreview,
  currentActionId,
  decisionTone,
  config,
  onConfigChange,
}: RightPanelProps) {
  return (
    <section className="right-panel">
      <RightPanelTabs tab={tab} onChange={onTabChange} decisionTone={decisionTone} />

      <div className="right-panel-view">
        {tab === 'decision' && <TimelinePanel decision={decision} policy={policy} state={state} />}

        {tab === 'library' && (
          <ActionLibrary onPreview={onPreview} currentActionId={currentActionId} />
        )}

        {tab === 'config' && (
          <ConfigPanel
            key={`${config.mode}-${config.model}-${config.endpoint}`}
            config={config}
            onChange={onConfigChange}
          />
        )}

        {tab === 'docs' && <JevDocsPanel />}

        {tab === 'tradeoff' && <TradeoffPanel />}
      </div>

      {/*
        执行轨迹常驻在页签之外：无论在看判定、动作库还是配置，
        "机器人正在执行哪一串动作"都不该消失。
      */}
      <ExecutionStrip events={timeline.slice(-24)} />
    </section>
  );
}
