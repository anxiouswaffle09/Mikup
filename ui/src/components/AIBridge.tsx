import { Check, ClipboardCopy, Loader2, SendHorizontal, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { MikupPayload } from '../types';
import { clsx } from 'clsx';

interface AIBridgeProps {
  payload: MikupPayload | null;
  workspaceDir: string | null;
  onSeek?: (timeSecs: number) => void;
  onHighlight?: (timeSecs: number) => void;
}

interface AgentAction {
  tool: string;
  time_secs?: number;
}

interface AgentActionEvent {
  tool: string;
  time_secs?: number;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  actions?: AgentAction[];
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0.00s';
  return `${seconds.toFixed(2)}s`;
}

/** Minimal markdown renderer: headers, bullets, bold, inline code, blank lines. */
function renderMarkdown(text: string, onSeek?: (t: number) => void, onHighlight?: (t: number) => void): React.ReactNode[] {
  return text.split('\n').map((line, i) => {
    const key = i;
    if (/^#{1,3}\s/.test(line)) {
      return (
        <p key={key} className="font-semibold text-text-main mt-2 first:mt-0">
          {inlineFormat(line.replace(/^#+\s/, ''), onSeek, onHighlight)}
        </p>
      );
    }
    if (/^[-*]\s/.test(line)) {
      return (
        <p key={key} className="pl-2">
          · {inlineFormat(line.slice(2), onSeek, onHighlight)}
        </p>
      );
    }
    if (line.trim() === '') {
      return <div key={key} className="h-1.5" />;
    }
    return <p key={key}>{inlineFormat(line, onSeek, onHighlight)}</p>;
  });
}

/** Handles **bold**, `inline code`, and [MM:SS] / [H:MM:SS] timestamp links within a line. */
function inlineFormat(line: string, onSeek?: (t: number) => void, onHighlight?: (t: number) => void): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*|`([^`]+)`|\[(\d{1,2}):(\d{2})(?::(\d{2}))?\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) {
      parts.push(
        <strong key={match.index} className="font-semibold text-text-main">
          {match[2]}
        </strong>
      );
    } else if (match[3] !== undefined) {
      parts.push(
        <code
          key={match.index}
          className="rounded px-0.5 bg-[oklch(0.95_0.01_250)] text-[oklch(0.45_0.14_260)] font-mono text-[0.9em]"
        >
          {match[3]}
        </code>
      );
    } else if (match[4] !== undefined) {
      // Timestamp [MM:SS] or [H:MM:SS]
      const h = match[6] !== undefined ? parseInt(match[4]) : 0;
      const m = match[6] !== undefined ? parseInt(match[5]) : parseInt(match[4]);
      const s = match[6] !== undefined ? parseInt(match[6]) : parseInt(match[5]);
      const totalSecs = h * 3600 + m * 60 + s;
      parts.push(
        <button
          key={match.index}
          type="button"
          className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-mono font-semibold bg-[oklch(0.94_0.04_260)] text-[oklch(0.40_0.14_260)] border border-[oklch(0.85_0.07_260)] hover:bg-[oklch(0.88_0.07_260)] transition-colors cursor-pointer"
          onClick={() => {
            onSeek?.(totalSecs);
            onHighlight?.(totalSecs);
          }}
          title={`Seek to ${match[0]}`}
        >
          ↗ {match[0]}
        </button>
      );
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex));
  }
  return parts.length ? parts : [line];
}

function ActionBadge({ action }: { action: AgentAction }) {
  const label = (() => {
    switch (action.tool) {
      case 'seek_audio':
        return `↗ Seeked to ${formatSeconds(action.time_secs ?? 0)}`;
      case 'get_diagnostic_events':
        return '⊞ Queried diagnostic events';
      case 'listen_to_audio_slice':
        return '♪ Analyzed audio slice';
      default:
        return `⚙ Used tool: ${action.tool}`;
    }
  })();

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-sm px-1.5 py-0.5 text-[9px] font-mono font-semibold tracking-wide',
        action.tool === 'seek_audio'
          ? 'bg-[oklch(0.94_0.04_260)] text-[oklch(0.40_0.14_260)]'
          : 'bg-[oklch(0.94_0.03_200)] text-[oklch(0.40_0.12_200)]'
      )}
    >
      {label}
    </span>
  );
}

const INITIAL_MESSAGE: ChatMessage = {
  id: 0,
  role: 'assistant',
  content:
    "I'm your AI Mix Director. I can seek to specific moments, query diagnostic events, and analyze audio slices.\n\nWhat would you like to know about this mix?",
};

export function AIBridge({ payload, workspaceDir, onSeek, onHighlight }: AIBridgeProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'thinking'>('idle');
  const [copied, setCopied] = useState<'idle' | 'ok' | 'error'>('idle');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingActionsRef = useRef<AgentAction[]>([]);
  const nextIdRef = useRef(1);

  // Subscribe to agent-action events emitted by Rust during tool execution.
  useEffect(() => {
    const unlistenPromise = listen<AgentActionEvent>('agent-action', (event) => {
      pendingActionsRef.current.push({
        tool: event.payload.tool,
        time_secs: event.payload.time_secs,
      });
    });
    return () => {
      unlistenPromise.then((f) => f());
    };
  }, []);

  // Scroll to bottom whenever messages change.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || status === 'thinking' || !workspaceDir) return;

    const userMsg: ChatMessage = {
      id: nextIdRef.current++,
      role: 'user',
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setStatus('thinking');
    pendingActionsRef.current = [];

    try {
      const responseText = await invoke<string>('send_agent_message', {
        text,
        workspaceDir,
      });

      const capturedActions = [...pendingActionsRef.current];
      pendingActionsRef.current = [];

      const assistantMsg: ChatMessage = {
        id: nextIdRef.current++,
        role: 'assistant',
        content: responseText || 'No response from the AI Director.',
        actions: capturedActions.length > 0 ? capturedActions : undefined,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      const errStr = err instanceof Error ? err.message : String(err);
      const isSecurityError =
        /path.denied|access.restricted|outside.workspace|must be an absolute/i.test(errStr);
      const errorMsg: ChatMessage = {
        id: nextIdRef.current++,
        role: 'assistant',
        content: isSecurityError
          ? 'Security: File access restricted.'
          : `Error: ${errStr}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setStatus('idle');
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCopyContext = async () => {
    if (!payload) return;
    const lines = [
      '# Mikup AI Bridge Context',
      '',
      `- Source: ${payload.metadata?.source_file?.split(/[\\/]/).pop() ?? 'unknown'}`,
      `- Duration: ${(payload.metrics?.spatial_metrics?.total_duration ?? 0).toFixed(2)}s`,
      `- Integrated LUFS: ${payload.metrics?.lufs_graph?.DX?.integrated?.toFixed(2) ?? payload.metrics?.lufs_graph?.dialogue_raw?.integrated?.toFixed(2) ?? 'N/A'}`,
      '',
      '## Chat History',
      ...messages.map((m) => `**${m.role === 'user' ? 'User' : 'Director'}:** ${m.content}`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      setCopied('ok');
    } catch {
      setCopied('error');
    }
    window.setTimeout(() => setCopied('idle'), 2200);
  };

  const isDisabled = !workspaceDir || !payload;

  return (
    <div className="flex h-full flex-col gap-0 animate-in fade-in slide-in-from-right-4 duration-500">
      {/* Header row */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-panel-border shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-[oklch(0.65_0.14_290)]" />
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-main">
            AI Director
          </span>
          {status === 'thinking' && (
            <span className="flex items-center gap-1 text-[9px] font-mono text-[oklch(0.65_0.14_290)]">
              <Loader2 size={10} className="animate-spin" />
              thinking…
            </span>
          )}
        </div>
        <button
          onClick={handleCopyContext}
          disabled={!payload}
          title="Copy chat context"
          className={clsx(
            'flex items-center gap-1 text-[9px] font-mono transition-colors',
            copied === 'ok' && 'text-[oklch(0.55_0.12_150)]',
            copied === 'error' && 'text-[oklch(0.55_0.15_25)]',
            copied === 'idle' && 'text-text-muted hover:text-accent',
            !payload && 'opacity-40 cursor-not-allowed'
          )}
        >
          {copied === 'ok' ? <Check size={10} /> : <ClipboardCopy size={10} />}
          {copied === 'ok' ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {isDisabled && (
          <p className="text-[10px] font-mono text-text-muted text-center mt-4">
            {!payload ? 'Load a project to start chatting.' : 'Workspace required to use AI Director.'}
          </p>
        )}
        {!isDisabled &&
          messages.map((msg) => (
            <div
              key={msg.id}
              className={clsx(
                'flex flex-col gap-1',
                msg.role === 'user' ? 'items-end' : 'items-start'
              )}
            >
              <div
                className={clsx(
                  'max-w-[90%] px-2.5 py-2 text-[10px] leading-relaxed font-mono',
                  msg.role === 'user'
                    ? 'bg-[oklch(0.94_0.04_260)] text-[oklch(0.25_0.10_260)] border border-[oklch(0.85_0.07_260)]'
                    : 'bg-[oklch(0.985_0.004_250)] text-text-muted border border-panel-border'
                )}
              >
                {msg.role === 'assistant'
                  ? renderMarkdown(msg.content, onSeek, onHighlight)
                  : msg.content}
              </div>
              {msg.actions && msg.actions.length > 0 && (
                <div className="flex flex-wrap gap-1 max-w-[90%]">
                  {msg.actions.map((action, i) => (
                    <ActionBadge key={i} action={action} />
                  ))}
                </div>
              )}
            </div>
          ))}
        {status === 'thinking' && (
          <div className="flex items-start">
            <div className="bg-[oklch(0.985_0.004_250)] border border-panel-border px-2.5 py-2 text-[10px] font-mono text-text-muted">
              <span className="flex items-center gap-1.5">
                <Loader2 size={10} className="animate-spin text-[oklch(0.65_0.14_290)]" />
                Analyzing mix…
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-panel-border px-2 py-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isDisabled || status === 'thinking'}
            placeholder={
              isDisabled
                ? 'Load a project to start…'
                : 'Ask the AI Director… (Enter to send)'
            }
            rows={2}
            className={clsx(
              'flex-1 resize-none bg-[oklch(0.99_0.003_250)] border border-panel-border',
              'px-2 py-1.5 text-[10px] font-mono text-text-main placeholder:text-text-muted',
              'focus:outline-none focus:border-[oklch(0.72_0.1_255)]',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || isDisabled || status === 'thinking'}
            className={clsx(
              'shrink-0 p-2 border transition-colors',
              !input.trim() || isDisabled || status === 'thinking'
                ? 'border-panel-border text-text-muted cursor-not-allowed opacity-50'
                : 'border-accent text-accent hover:bg-accent/10'
            )}
            title="Send message (Enter)"
          >
            <SendHorizontal size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
