interface RightPanelTabsProps {
  tab: RightTab;
  onChange: (tab: RightTab) => void;
  /** 判定页签上状态点的颜色 */
  decisionTone: string;
}

export type RightTab = 'decision' | 'library' | 'config';

const ITEMS: { id: RightTab; icon: string; label: string }[] = [
  { id: 'decision', icon: '◎', label: 'Jev 判定' },
  { id: 'library', icon: '▦', label: '动作库' },
  { id: 'config', icon: '⚙', label: 'Jev 配置' },
];

/**
 * 右列顶部的横向页签条。
 *
 * 曾经做成贴在最左侧的竖向图标轨道，但那样会在三栏布局里多出一条没来由的
 * 竖带，跟舞台、对话的边框对不齐，整页看着突兀。横排放在模块顶部，
 * 与下方内容同宽同边，视觉上才是一个完整模块。
 */
export function RightPanelTabs({ tab, onChange, decisionTone }: RightPanelTabsProps) {
  return (
    <nav className="tabs" role="tablist" aria-label="右侧面板">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          role="tab"
          aria-selected={tab === item.id}
          className={tab === item.id ? 'active' : ''}
          onClick={() => onChange(item.id)}
        >
          <i aria-hidden>{item.icon}</i>
          {item.label}
          {item.id === 'decision' && (
            <span className="tab-dot" style={{ background: decisionTone }} />
          )}
        </button>
      ))}
    </nav>
  );
}
