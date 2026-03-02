import React, { useState, useEffect, useRef } from 'react';
import { FileAudio, ChevronRight, Search } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { parseHistoryEntry } from '../types';
import type { AppConfig, HistoryEntry, MikupPayload } from '../types';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { clsx } from 'clsx';

interface LandingHubProps {
  onSelectProject: (payload: MikupPayload) => void;
  onStartNewProcess: (filePath: string, overrideDir?: string) => void;
  isProcessing: boolean;
  config: AppConfig | null;
  onChangeDefaultFolder: () => void;
}

export const LandingHub: React.FC<LandingHubProps> = ({
  onSelectProject,
  onStartNewProcess,
  isProcessing,
  config,
  onChangeDefaultFolder,
}) => {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualOverrideDir, setManualOverrideDir] = useState<string | null>(null);

  const loadHistory = async () => {
    try {
      const data = await invoke<unknown[]>('get_history');
      const parsed = Array.isArray(data)
        ? data.map(parseHistoryEntry).filter((e): e is HistoryEntry => e !== null)
        : [];
      setHistory(parsed);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  };

  const handlePickManualFolder = async () => {
    const selected = await open({
      multiple: false,
      directory: true,
      title: 'Choose output folder for this run',
    });
    if (typeof selected === 'string') {
      setManualOverrideDir(selected);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHistory();
  }, []);

  // Stable refs so the listener always sees the latest values without re-registering.
  const isProcessingRef = useRef(isProcessing);
  const manualOverrideDirRef = useRef(manualOverrideDir);
  const onStartNewProcessRef = useRef(onStartNewProcess);
  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);
  useEffect(() => { manualOverrideDirRef.current = manualOverrideDir; }, [manualOverrideDir]);
  useEffect(() => { onStartNewProcessRef.current = onStartNewProcess; }, [onStartNewProcess]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'enter' || payload.type === 'over') {
        setIsDragging(true);
      } else if (payload.type === 'leave') {
        setIsDragging(false);
      } else if (payload.type === 'drop') {
        setIsDragging(false);
        if (isProcessingRef.current) return;
        const audioFilePath = payload.paths.find(p =>
          p.toLowerCase().endsWith('.wav') ||
          p.toLowerCase().endsWith('.mp3') ||
          p.toLowerCase().endsWith('.flac')
        );
        if (audioFilePath) {
          onStartNewProcessRef.current(audioFilePath, manualOverrideDirRef.current ?? undefined);
        }
      }
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const handleSelectFile = async () => {
    const selectedPath = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: 'Audio',
          extensions: ['wav', 'mp3', 'flac'],
        },
      ],
    });

    if (typeof selectedPath === 'string') {
      onStartNewProcess(selectedPath, manualOverrideDir ?? undefined);
    }
  };

  const filteredHistory = history.filter(item =>
    (item.filename ?? '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 animate-in fade-in duration-500">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-text-main">Mikup</h1>
        <span className="text-[11px] font-mono text-text-muted">v0.1.0-alpha</span>
      </header>

      {config?.default_projects_dir && (
        <div className="flex items-center gap-3 mb-6 font-mono text-[11px] text-text-muted">
          <span className="uppercase tracking-widest font-bold">Default workspace</span>
          <span className="flex-1 truncate" title={config.default_projects_dir}>
            {config.default_projects_dir}
          </span>
          <button
            type="button"
            onClick={onChangeDefaultFolder}
            className="shrink-0 text-[10px] text-accent hover:underline"
          >
            Change
          </button>
        </div>
      )}

      <div className="border-t border-panel-border pt-6 mb-2">
        <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-3">
          Drop an audio file to begin &nbsp;·&nbsp; .wav .mp3 .flac
        </p>
        <div
          onClick={handleSelectFile}
          className={clsx(
            "h-28 border border-dashed flex items-center justify-center transition-colors duration-200 cursor-pointer select-none",
            isDragging
              ? "border-accent bg-accent/5 text-accent"
              : "border-panel-border text-text-muted hover:border-accent/50 hover:text-accent/70",
            isProcessing && "opacity-40 pointer-events-none"
          )}
        >
          <span className="text-sm">
            {isProcessing ? 'Processing...' : 'Drag & drop or click to select'}
          </span>
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => {
              setShowAdvanced((v) => !v);
              if (showAdvanced) setManualOverrideDir(null);
            }}
            className="flex items-center gap-1.5 text-[10px] font-mono text-text-muted hover:text-accent transition-colors select-none"
          >
            <span
              className="transition-transform duration-150"
              style={{ display: 'inline-block', transform: showAdvanced ? 'rotate(90deg)' : 'none' }}
            >
              ▸
            </span>
            Advanced: Manual Folder
          </button>

          {showAdvanced && (
            <div className="mt-2 flex items-center gap-3 pl-4">
              <button
                type="button"
                onClick={handlePickManualFolder}
                className="text-[11px] font-mono border border-panel-border px-2 py-1 text-text-muted hover:border-accent hover:text-accent transition-colors"
              >
                Choose Folder…
              </button>
              {manualOverrideDir ? (
                <span
                  className="text-[11px] font-mono text-text-muted truncate flex-1"
                  title={manualOverrideDir}
                >
                  {manualOverrideDir}
                </span>
              ) : (
                <span className="text-[11px] font-mono text-text-muted italic">
                  No folder selected — default will be used
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-panel-border pt-6 mt-8">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Recent</p>
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder="Search..."
              className="bg-transparent border border-panel-border pl-7 pr-3 py-1 text-xs focus:outline-none focus:border-accent transition-colors"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-px">
          {filteredHistory.length > 0 ? (
            filteredHistory.map((entry) => {
              const isCorrupt = !entry.payload.metrics || !entry.payload.metadata;
              const dateStr = entry.date
                ? new Date(entry.date).toLocaleDateString()
                : 'Unknown date';
              const durationStr = typeof entry.duration === 'number'
                ? `${(entry.duration / 60).toFixed(1)}m`
                : '--';
              return (
                <button
                  key={entry.id}
                  onClick={() => !isCorrupt && onSelectProject(entry.payload)}
                  disabled={isCorrupt}
                  className="w-full group text-left flex items-center gap-4 py-2.5 px-1 border-b border-panel-border hover:bg-accent/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <FileAudio size={14} className="text-text-muted shrink-0" />
                  <span className="flex-1 text-sm font-mono truncate">
                    {isCorrupt
                      ? <span className="text-red-400">Data Corrupt — {entry.filename}</span>
                      : <span className="text-text-main">{entry.filename}</span>
                    }
                  </span>
                  <span className="text-[11px] font-mono text-text-muted tabular-nums">{dateStr}</span>
                  <span className="text-[11px] font-mono text-text-muted tabular-nums">{durationStr}</span>
                  <ChevronRight size={12} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              );
            })
          ) : (
            <p className="text-sm text-text-muted py-6">No history found.</p>
          )}
        </div>
      </div>
    </div>
  );
};
