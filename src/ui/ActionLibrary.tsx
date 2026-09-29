import { useEffect, useMemo, useState } from 'react';
import { ACTION_LIBRARY } from '../domain/actionLibrary';
import type { RobotAction } from '../domain/types';

interface ActionLibraryProps {
  onPreview: (action: RobotAction) => void;
  /** 当前正在执行的动作，用于高亮 */
  currentActionId?: string | null;
}

/** 按主执行器分组，顺序即展示顺序 */
const GROUPS: { key: string; name: string }[] = [
  { key: 'head', name: '头部云台' },
  { key: 'screen', name: '屏幕表情' },
  { key: 'arm', name: '机械臂' },
  { key: 'base', name: '移动底盘' },
  { key: 'audio', name: '声音' },
  { key: 'body', name: '待机身体' },
];

/** 动作库主键下方的参数摘要：只显示带默认值的参数，便于单独调参时心里有数 */
function paramSummary(action: RobotAction): string {
  const named = action.params
    .filter((p) => p.default !== undefined)
    .map((p) => `${p.name} ${String(p.default)}`);
  return named.slice(0, 3).join(' · ');
}

/**
 * 动作库。
 *
 * 从右侧判定栏搬到左侧之后，它拿到的是整列宽度——
 * 29 个短按钮因此能按 6 个执行器分组近乎一屏铺开，不必再逐组滚动。
 * 默认折叠到「执行器 + 一列按钮」的紧凑级，需要逐项调参时再切到宽松级。
 */
export function ActionLibrary({ onPreview, currentActionId }: ActionLibraryProps) {
  /**
   * 默认走最密的排法，让 29 个动作尽量一屏看完；
   * 需要看 id 与参数（单独调参、核对编排）时再切到宽松级。
   */
  const [loose, setLoose] = useState(false);
  const [keyword, setKeyword] = useState('');

  /**
   * 运行中卡片的进度条要靠自身的时钟推进。
   * 用 200ms 的粗粒度心跳足够，避免把它挂到 App 的 rAF 循环上，
   * 否则高帧率会让整棵动作库树每帧重渲染。
   */
  const [now, setNow] = useState(() => Date.now());
  const running = Boolean(currentActionId);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [running]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return ACTION_LIBRARY;
    return ACTION_LIBRARY.filter(
      (a) =>
        a.label.toLowerCase().includes(kw) ||
        a.id.toLowerCase().includes(kw) ||
        a.aliases.some((alias) => alias.toLowerCase().includes(kw)),
    );
  }, [keyword]);

  const grouped = useMemo(() => {
    const map = new Map<string, RobotAction[]>();
    for (const action of filtered) {
      const primary = action.actuators[0] ?? 'other';
      const list = map.get(primary) ?? [];
      list.push(action);
      map.set(primary, list);
    }
    const known = GROUPS.filter((g) => map.has(g.key)).map(
      (g) => [g.name, map.get(g.key)!] as [string, RobotAction[]],
    );
    const rest = [...map.entries()]
      .filter(([key]) => !GROUPS.some((g) => g.key === key))
      .map(([key, value]) => [key, value] as [string, RobotAction[]]);
    return [...known, ...rest];
  }, [filtered]);

  return (
    <section className="library-panel">
      <header className="panel-header">
        <h2>动作库</h2>
        <div className="header-actions">
          <input
            className="lib-search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜动作 / 别名"
            aria-label="搜索动作"
          />
          <button
            className={`ghost-btn ${loose ? 'active' : ''}`}
            onClick={() => setLoose((v) => !v)}
            title={loose ? '收起 id 与参数，排得更密' : '展开 id 与参数，便于调参'}
          >
            {loose ? '宽松' : '紧凑'}
          </button>
        </div>
      </header>

      <p className="lib-hint">
        共 {ACTION_LIBRARY.length} 个动作，点击直接播放，绕过决策层，用于单独调参；
        <em>紧凑 / 宽松</em> 切换排列密度。
        {filtered.length !== ACTION_LIBRARY.length && (
          <b className="lib-filtered">
            已按「{keyword}」筛出 {filtered.length} 个
          </b>
        )}
      </p>

      <div className={`library-groups ${loose ? 'loose' : ''}`}>
        {grouped.map(([name, items]) => (
          <section key={name} className="lib-section">
            <h4>
              {name}
              <em>{items.length}</em>
            </h4>
            <div className="lib-items">
              {items.map((a) => {
                const summary = paramSummary(a);
                const running = a.id === currentActionId;
                return (
                  <button
                    key={a.id}
                    className={`lib-card ${running ? 'running' : ''}`}
                    title={`${a.description}\n${a.id} · ${a.actuators.join('+')} · ${a.durationMs}ms${
                      summary ? `\n参数 ${summary}` : ''
                    }`}
                    onClick={() => onPreview(a)}
                  >
                    {running && (
                      /**
                       * 进度条按真实时间推进：用「已流逝时间 / 动作时长」求比例。
                       * 相比 CSS 动画，这样在动作被打断重排时也能立刻回到正确位置。
                       */
                      <span className="lib-progress">
                        <i
                          style={{
                            width: `${Math.min(100, ((now / a.durationMs) % 1) * 100)}%`,
                          }}
                        />
                      </span>
                    )}
                    <span className="lib-card-head">
                      <b>{a.label}</b>
                      <em>{a.durationMs}ms</em>
                    </span>
                    <code>{a.id}</code>
                    {summary && <span className="lib-card-params">{summary}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        {grouped.length === 0 && <p className="empty-hint">没有匹配「{keyword}」的动作</p>}
      </div>
    </section>
  );
}
