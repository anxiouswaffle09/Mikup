import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

interface ConsoleEntry {
  id: number;
  stage: string;
  message: string;
  progress: number;
  timestamp: string;
}

interface StageStyle {
  color: string;
  emoji: string;
  label: string;
}

const STAGE_STYLES: Record<string, StageStyle> = {
  SEPARATION: { color: 'text-fuchsia-400', emoji: '📽️', label: 'CINEMA' },
  CINEMA:     { color: 'text-fuchsia-400', emoji: '📽️', label: 'CINEMA' },
  VOX:        { color: 'text-cyan-400',    emoji: '💎', label: 'VOX'    },
  DX:         { color: 'text-cyan-400',    emoji: '💎', label: 'DX'     },
  DIALOGUE:   { color: 'text-cyan-400',    emoji: '💎', label: 'DX'     },
  DSP:        { color: 'text-blue-400',    emoji: '📊', label: 'DSP'    },
  TRANSCRIPTION: { color: 'text-green-400', emoji: '📝', label: 'TRANSCRIPTION' },
  FX:         { color: 'text-amber-400',   emoji: '⚡', label: 'FX'      },
  EFFECTS:    { color: 'text-amber-400',   emoji: '⚡', label: 'EFFECTS' },
  COMPLETE:   { color: 'text-emerald-400', emoji: '✓',  label: 'DONE'   },
};

function resolveStageStyle(stage: string): StageStyle {
  const key = stage.toUpperCase().trim();
  return (
    STAGE_STYLES[key] ??
    Object.entries(STAGE_STYLES).find(([k]) => key.startsWith(k))?.[1] ??
    { color: 'text-zinc-400', emoji: '·', label: key || '···' }
  );
}

function formatTimestamp(): string {
  const now = new Date();
  return [
    now.getHours().toString().padStart(2, '0'),
    now.getMinutes().toString().padStart(2, '0'),
    now.getSeconds().toString().padStart(2, '0'),
  ].join(':');
}

export function MikupConsole() {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef(0);

  useEffect(() => {
    const unlisten = listen<{ stage: string; progress: number; message: string }>(
      'process-status',
      (event) => {
        const { stage, progress, message } = event.payload;
        if (!message.trim()) return;
        setEntries((prev) => [
          ...prev,
          {
            id: ++counterRef.current,
            stage,
            message,
            progress,
            timestamp: formatTimestamp(),
          },
        ]);
      },
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Auto-scroll to bottom on new entries.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <div
      className="w-full h-full overflow-y-auto rounded select-text"
      style={{ background: '#0a0a0a', fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" }}
    >
      {entries.length === 0 ? (
        <div className="flex items-center justify-center h-full">
          <span className="text-[11px] text-zinc-600 uppercase tracking-widest animate-pulse">
            Awaiting pipeline output…
          </span>
        </div>
      ) : (
        <div className="p-3 space-y-0.5">
          {entries.map((entry) => {
            const style = resolveStageStyle(entry.stage);
            return (
              <div key={entry.id} className="flex items-baseline gap-2 leading-5">
                <span className="text-[9px] text-zinc-600 tabular-nums shrink-0 w-[46px]">
                  {entry.timestamp}
                </span>
                <span className={`text-[10px] font-bold shrink-0 w-[72px] ${style.color}`}>
                  [{style.label}]
                </span>
                <span className="text-[10px] shrink-0">{style.emoji}</span>
                <span className="text-[11px] text-zinc-300 flex-1 min-w-0 break-words">
                  {entry.message}
                </span>
                {entry.progress > 0 && entry.progress < 100 && (
                  <span className="text-[9px] text-zinc-500 tabular-nums shrink-0 ml-auto">
                    {entry.progress}%
                  </span>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
