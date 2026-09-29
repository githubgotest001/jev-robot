import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../domain/types';

interface ChatPanelProps {
  messages: ChatMessage[];
  /** 机器人是否正在执行动作（决定是否显示紧急停止） */
  busy: boolean;
  /** 是否正在等待 Jev 判定（决定是否禁用输入、显示加载提示） */
  deciding: boolean;
  showReasoning: boolean;
  onSend: (text: string, choiceId?: string) => void;
  onAbort: () => void;
  onReset: () => void;
}

/** 底部常用指令，点一下等价于说这句话 */
const QUICK_COMMANDS = [
  '你好',
  '给我跳个舞',
  '帮我拿个东西',
  '讲个笑话',
  '夸夸你',
  '陪我一会儿',
  '往左转',
  '回去',
  '去睡觉',
  '停下',
];

const EMOTION_EMOJI: Record<string, string> = {
  neutral: '😐',
  happy: '😊',
  excited: '🤩',
  curious: '🤔',
  confused: '😕',
  sad: '😢',
  angry: '😠',
  sleepy: '😴',
  focus: '🧐',
};

export function ChatPanel({
  messages,
  busy,
  deciding,
  showReasoning,
  onSend,
  onAbort,
  onReset,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastMsgId = messages[messages.length - 1]?.id;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastMsgId]);

  const submit = () => {
    const text = input.trim();
    if (!text || deciding) return;
    onSend(text);
    setInput('');
  };

  return (
    <section className="chat-panel">
      <header className="panel-header">
        <h2>语音指令</h2>
        <div className="header-actions">
          {busy && (
            <button className="danger-btn" onClick={onAbort}>
              紧急停止
            </button>
          )}
          <button className="ghost-btn" onClick={onReset}>
            复位
          </button>
        </div>
      </header>

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            <p>用语音输入法在下方说话，或点选快捷指令。</p>
            <p className="hint">JEV 会把你的话转成回复和一串机器人动作。</p>
          </div>
        )}

        {messages.map((msg) => (
          <article key={msg.id} className={`msg msg-${msg.role}`}>
            <div className="msg-avatar">
              {msg.role === 'user' ? '你' : EMOTION_EMOJI[msg.emotion ?? 'neutral'] ?? '🤖'}
            </div>
            <div className="msg-body">
              {msg.role === 'user' && msg.source === 'choice' && (
                <span className="msg-source">来自选项</span>
              )}
              <p className="msg-content">{msg.content}</p>
              {msg.actionIds && msg.actionIds.length > 0 && (
                <div className="msg-actions">
                  {msg.actionIds.map((id) => (
                    <span key={id} className="action-chip">
                      {id}
                    </span>
                  ))}
                </div>
              )}
              {showReasoning && msg.reasoning && <p className="msg-reasoning">{msg.reasoning}</p>}
              {msg.choices && msg.choices.length > 0 && (
                <div className="choices">
                  {msg.choices.map((c) => (
                    <button
                      key={c.id}
                      className="choice-btn"
                      disabled={deciding}
                      onClick={() => onSend(c.value, c.id)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
              {msg.latencyMs !== undefined && (
                <span className="msg-latency">{msg.latencyMs}ms</span>
              )}
            </div>
          </article>
        ))}

        {deciding && (
          <div className="thinking">
            <span />
            <span />
            <span />
            Jev 判定中…
          </div>
        )}
      </div>

      <div className="quick-row">
        {QUICK_COMMANDS.map((c) => (
          <button key={c} className="quick-btn" disabled={deciding} onClick={() => onSend(c)}>
            {c}
          </button>
        ))}
      </div>

      <div className="input-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="按住说话 / 用语音输入法输入…"
          disabled={deciding}
        />
        <button className="primary-btn" onClick={submit} disabled={deciding || !input.trim()}>
          发送
        </button>
      </div>
    </section>
  );
}