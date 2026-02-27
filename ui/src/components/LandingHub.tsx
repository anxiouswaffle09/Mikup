import React, { useState, useEffect } from 'react';
import { FileAudio, ChevronRight, Search } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { HistoryEntry, MikupPayload } from '../types';
import { clsx } from 'clsx';

interface LandingHubProps {
  onSelectProject: (payload: MikupPayload) => void;
  onStartNewProcess: (filePath: string) => void;
  isProcessing: boolean;
}

export const LandingHub: React.FC<LandingHubProps> = ({
  onSelectProject,
  onStartNewProcess,
  isProcessing,
}) => {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadHistory = async () => {
    try {
      const data = await invoke<HistoryEntry[]>('get_history');
      setHistory(data);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHistory();
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    const audioFile = files.find(f =>
      f.name.endsWith('.wav') || f.name.endsWith('.mp3') || f.name.endsWith('.flac')
    );
    if (audioFile && !isProcessing) {
      onStartNewProcess(audioFile.name);
    }
  };

  const filteredHistory = history.filter(item =>
    item.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 animate-in fade-in duration-500">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-text-main">Mikup</h1>
        <span className="text-[11px] font-mono text-text-muted">v0.1.0-alpha</span>
      </header>

      <div className="border-t border-panel-border pt-6 mb-2">
        <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-3">
          Drop an audio file to begin &nbsp;·&nbsp; .wav .mp3 .flac
        </p>
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={clsx(
            "h-28 border border-dashed flex items-center justify-center transition-colors duration-200 cursor-default select-none",
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
            filteredHistory.map((entry) => (
              <button
                key={entry.id}
                onClick={() => onSelectProject(entry.payload)}
                className="w-full group text-left flex items-center gap-4 py-2.5 px-1 border-b border-panel-border hover:bg-accent/5 transition-colors"
              >
                <FileAudio size={14} className="text-text-muted shrink-0" />
                <span className="flex-1 text-sm text-text-main font-mono truncate">
                  {entry.filename}
                </span>
                <span className="text-[11px] font-mono text-text-muted tabular-nums">
                  {new Date(entry.date).toLocaleDateString()}
                </span>
                <span className="text-[11px] font-mono text-text-muted tabular-nums">
                  {(entry.duration / 60).toFixed(1)}m
                </span>
                <ChevronRight size={12} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ))
          ) : (
            <p className="text-sm text-text-muted py-6">No history found.</p>
          )}
        </div>
      </div>
    </div>
  );
};
