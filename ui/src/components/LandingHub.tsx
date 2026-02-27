import React, { useState, useEffect } from 'react';
import { Upload, History, FileAudio, ChevronRight, Search, Clock, Database } from 'lucide-react';
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
  isProcessing 
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

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    const audioFile = files.find(f => 
      f.name.endsWith('.wav') || 
      f.name.endsWith('.mp3') || 
      f.name.endsWith('.flac')
    );

    if (audioFile && !isProcessing) {
      // In a real Tauri app, we'd get the full path. 
      // For web/mock, we use the name.
      onStartNewProcess(audioFile.name);
    }
  };

  const filteredHistory = history.filter(item => 
    item.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="max-w-6xl mx-auto px-6 py-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <header className="mb-12">
        <h1 className="text-4xl font-light tracking-tight text-text-main mb-2">
          Project <span className="font-semibold">Mikup</span>
        </h1>
        <p className="text-text-muted text-lg">The Clinical Audio Laboratory</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left: Drag & Drop Zone */}
        <div className="lg:col-span-2 space-y-8">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={clsx(
              "relative h-96 rounded-3xl border-2 border-dashed transition-all duration-500 flex flex-col items-center justify-center overflow-hidden",
              isDragging 
                ? "border-accent bg-accent/5 scale-[1.02] shadow-2xl" 
                : "border-panel-border bg-panel/50 hover:bg-panel hover:border-accent/40",
              isProcessing && "opacity-50 cursor-not-allowed"
            )}
          >
            <div className={clsx(
              "p-6 rounded-full bg-accent/10 text-accent mb-6 transition-transform duration-500",
              isDragging && "scale-110"
            )}>
              <Upload size={48} strokeWidth={1.5} />
            </div>
            <h2 className="text-2xl font-medium text-text-main mb-2">
              {isProcessing ? 'Processing in progress...' : 'Drop Audio Drama Here'}
            </h2>
            <p className="text-text-muted text-center max-w-xs px-4">
              Support for .wav, .mp3, and .flac files. Surgical separation and EBU R128 analysis will begin immediately.
            </p>

            {/* Subtle Gradient Overlay */}
            <div className="absolute inset-0 bg-gradient-to-br from-accent/5 to-transparent pointer-events-none" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FeatureCard 
              icon={<Database size={20} />} 
              title="Persistent History" 
              desc="Access past scans instantly without reprocessing." 
            />
            <FeatureCard 
              icon={<FileAudio size={20} />} 
              title="EBU R128 LUFS" 
              desc="Broadcast-grade loudness measurement." 
            />
            <FeatureCard 
              icon={<Clock size={20} />} 
              title="Real-time Progress" 
              desc="Visual step-by-step pipeline tracking." 
            />
          </div>
        </div>

        {/* Right: History Sidebar */}
        <div className="lg:col-span-1 flex flex-col h-full space-y-4">
          <div className="panel p-6 flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2 text-text-main">
                <History size={20} className="text-accent" />
                <h3 className="font-semibold text-lg">Recent Projects</h3>
              </div>
              <span className="text-xs bg-accent/10 text-accent px-2 py-1 rounded-full font-medium">
                {history.length}
              </span>
            </div>

            <div className="relative mb-4">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input 
                type="text" 
                placeholder="Search scans..." 
                className="w-full bg-background border border-panel-border rounded-xl py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent/40 transition-all"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
              {filteredHistory.length > 0 ? (
                filteredHistory.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => onSelectProject(entry.payload)}
                    className="w-full group text-left p-3 rounded-2xl border border-transparent hover:border-panel-border hover:bg-background transition-all duration-300 flex items-center gap-3"
                  >
                    <div className="p-2.5 rounded-xl bg-accent/5 text-accent group-hover:bg-accent group-hover:text-white transition-colors">
                      <FileAudio size={20} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-text-main truncate group-hover:text-accent transition-colors">
                        {entry.filename}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-text-muted mt-0.5">
                        <span>{new Date(entry.date).toLocaleDateString()}</span>
                        <span>•</span>
                        <span>{(entry.duration / 60).toFixed(1)}m</span>
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity -translate-x-2 group-hover:translate-x-0" />
                  </button>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="p-4 rounded-full bg-panel-border/20 text-text-muted mb-4">
                    <History size={32} strokeWidth={1} />
                  </div>
                  <p className="text-text-muted text-sm">No history found.<br/>Start your first analysis above.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const FeatureCard: React.FC<{ icon: React.ReactNode; title: string; desc: string }> = ({ icon, title, desc }) => (
  <div className="panel p-5 hover:translate-y-[-4px] transition-all duration-300">
    <div className="text-accent mb-3">{icon}</div>
    <h4 className="font-semibold text-text-main mb-1">{title}</h4>
    <p className="text-xs text-text-muted leading-relaxed">{desc}</p>
  </div>
);
