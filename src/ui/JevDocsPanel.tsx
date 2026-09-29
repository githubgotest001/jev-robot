/**
 * Jev 核心用法速查。
 *
 * 只收"改这个工程时会用到"的部分：协议形状、三种提问怎么选、
 * 概率怎么读、以及本项目的阈值策略怎么对应。每节末尾给出官方出处，
 * 需要更完整的说明时点链接即可，不必离开界面。
 *
 * 刻意不复述 README：README 讲这个工程怎么做，这里讲 Jev 怎么用。
 */

interface DocLink {
  label: string;
  href: string;
}

const DOCS: DocLink[] = [
  { label: '官方文档', href: 'https://thejevai.com/docs' },
  { label: 'API Key', href: 'https://thejevai.com/settings/apikeys' },
  { label: 'OpenRouter', href: 'https://openrouter.ai/api/alpha/decisions' },
  { label: 'TypeSafe 官方', href: 'https://api.typesafe.ai/v1/systemone' },
];

/** 三种提问类型：官方字段 + 本工程实例 */
const QUESTION_TYPES = [
  {
    name: 'choice',
    use: '分类或路由',
    returns: 'choice · probabilities · confidence',
    example: 'intent：从 28 个意图里选一个',
  },
  {
    name: 'score',
    use: '在有序档位上评分',
    returns: 'score · legend · probabilities · confidence',
    example: '协议已支持，本项目暂未提问',
  },
  {
    name: 'noul',
    use: '判断某个命题成立的概率',
    returns: 'noul（没有独立的 confidence 字段）',
    example: 'safe_to_execute：现在能不能安全执行',
  },
];

export function JevDocsPanel() {
  return (
    <div className="docs-body">
      <div className="docs-intro">
        <h4>Jev 是什么</h4>
        <p>
          <b>非生成式决策模型</b>。给一份 state 加一组定型问题，
          返回可被代码直接分支的定型值——不产出任何文字。
        </p>
        <p className="docs-note">
          代价按输入 token 计、输出免费。因此本工程让它只做判定，
          话术与动作编排全部由代码决定。
        </p>
      </div>

      <div className="docs-section">
        <h4>输入：一个 state</h4>
        <p>
          只接受<b>文本、JSON 对象、文本数组</b>；暂不支持图像、音频、视频。
          本工程传 JSON 对象，各问题的 instructions 用反引号按字段名引用。
        </p>
        <p className="docs-note">
          多个问题在<b>同一个 state 上并行评估，彼此看不到对方的答案</b>。
          因此后两个问题不能引用 <code>intent</code>——安全闸门改读 state 里的{' '}
          <code>requested_capabilities</code>。
        </p>
      </div>

      <div className="docs-section">
        <h4>提问：三种类型</h4>
        <div className="docs-types">
          {QUESTION_TYPES.map((t) => (
            <div key={t.name} className="docs-type">
              <div className="docs-type-head">
                <code>{t.name}</code>
                <span>{t.use}</span>
              </div>
              <div className="docs-type-ret">返回 {t.returns}</div>
              <div className="docs-type-eg">本工程：{t.example}</div>
            </div>
          ))}
        </div>
        <p className="docs-note">
          choice 最多 255 个选项；score 需 2~10 档，由低到高，
          返回的 score 是概率加权值，可以落在档位之间。
        </p>
      </div>

      <div className="docs-section">
        <h4>读概率：三条要紧的</h4>
        <ul className="docs-list">
          <li>
            <b>noul ≈ 0.5 表示"不知道"</b>，不是"半安全"。
            要当第三种结果处理，此时应当反问而不是硬选。
          </li>
          <li>
            <b>confidence 高不代表对</b>。它衡量的是分布集中度，
            选得对不对取决于 <code>criteria</code> 描述写得好不好。
          </li>
          <li>
            <b>阈值由应用按风险自定</b>。官方建议高风险动作抬高门槛并保留人工复核路径。
          </li>
        </ul>
      </div>

      <div className="docs-section">
        <h4>本工程的判定链</h4>
        <div className="docs-flow">
          <span>state</span>
          <i>→</i>
          <span>3 个问题并行</span>
          <i>→</i>
          <span>定型答案 + 概率</span>
          <i>→</i>
          <span>代码路由成动作</span>
        </div>
        <p className="docs-note">
          intent 用 confidence 走两档门槛（普通 0.70 / 高风险 0.85）；
          safe_to_execute 的 noul 走三态：低于 0.40 拦截、
          {' '}{'0.40~0.60 判定不确定改为反问'}、高于 0.60 放行。
        </p>
      </div>

      <div className="docs-section">
        <h4>错误与重试</h4>
        <div className="docs-table">
          <div className="docs-tr docs-th">
            <span>状态码</span>
            <span>含义</span>
            <span>处理</span>
          </div>
          {[
            ['401', '密钥缺失或无效', '检查 Authorization 头'],
            ['422', '请求体校验失败', '检查 state / questions 结构'],
            ['429', '超出速率限制', '指数退避后重试'],
            ['529', '服务过载', '指数退避后重试'],
          ].map((row) => (
            <div key={row[0]} className="docs-tr">
              <span>{row[0]}</span>
              <span>{row[1]}</span>
              <span>{row[2]}</span>
            </div>
          ))}
        </div>
        <p className="docs-note">
          密钥只放服务端环境变量，不要写进浏览器代码或提交进仓库。
          本工程走本地代理，浏览器不持有密钥。
        </p>
      </div>

      <div className="docs-section">
        <h4>出处</h4>
        <div className="docs-links">
          {DOCS.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer noopener">
              {l.label}
              <i aria-hidden>↗</i>
            </a>
          ))}
        </div>
        <p className="docs-note">
          本页内容依据官方文档整理；如与官网不一致，以官网为准。
        </p>
      </div>
    </div>
  );
}