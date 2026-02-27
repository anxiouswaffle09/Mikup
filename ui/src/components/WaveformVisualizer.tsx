import { useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, RefreshCcw } from 'lucide-react';
import type { PacingMikup } from '../types';

interface WaveformVisualizerProps {
  pacing?: PacingMikup[];
  duration?: number;
  audioSources?: string[];
  outputDir?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toWaveSurferSource(path: string, outputDir?: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('file://')) return trimmed;

  // Resolve relative paths to absolute using outputDir
  let resolved = trimmed;
  if (!resolved.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(resolved) && outputDir) {
    resolved = `${outputDir}/${resolved}`;
  }

  // Convert any absolute local path to a Tauri-safe asset URL
  if (resolved.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(resolved)) {
    try {
      return convertFileSrc(resolved);
    } catch {
      return resolved;
    }
  }

  return resolved;
}

export function WaveformVisualizer({ pacing, duration = 10, audioSources, outputDir }: WaveformVisualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const loadSequenceRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const localSources = useMemo(() => {
    const uniqueSources = new Set<string>();
    for (const source of audioSources ?? []) {
      const trimmed = source.trim();
      if (!trimmed || /^https?:\/\//i.test(trimmed)) continue;
      uniqueSources.add(trimmed);
    }
    return Array.from(uniqueSources);
  }, [audioSources]);

  const effectiveDuration = duration > 0 ? duration : 10;
  const markers = (pacing ?? []).map((gap, index) => {
    const startSeconds = clamp(gap.timestamp, 0, effectiveDuration);
    const spanSeconds = clamp(gap.duration_ms / 1000, 0, effectiveDuration);
    const leftPercent = (startSeconds / effectiveDuration) * 100;
    const widthPercent = clamp(
      (spanSeconds / effectiveDuration) * 100,
      0.1, 
      100 - leftPercent,
    );
    return {
      key: `${gap.timestamp}-${gap.duration_ms}-${index}`,
      leftPercent,
      widthPercent,
      durationMs: gap.duration_ms,
    };
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: 'oklch(0.9 0.01 250)',
      progressColor: 'var(--color-accent)',
      cursorColor: 'var(--color-accent)',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 3,
      barRadius: 4,
      height: 140,
      hideScrollbar: true,
      normalize: true,
    });

    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    ws.on('ready', () => setIsReady(true));

    wavesurferRef.current = ws;

    return () => {
      ws.destroy();
      wavesurferRef.current = null;
    };
  }, []);

  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || localSources.length === 0) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsReady(false);
    const loadSequence = ++loadSequenceRef.current;

    const loadNextSource = (sourceIndex: number) => {
      if (sourceIndex >= localSources.length) return;

      const selectedSource = toWaveSurferSource(localSources[sourceIndex], outputDir);
      
      wavesurfer.once('ready', () => {
        if (loadSequence !== loadSequenceRef.current) return;
      });

      wavesurfer.once('error', () => {
        if (loadSequence === loadSequenceRef.current) {
          loadNextSource(sourceIndex + 1);
        }
      });

      wavesurfer.load(selectedSource);
    };

    loadNextSource(0);
  }, [localSources, outputDir]);

  const togglePlay = () => wavesurferRef.current?.playPause();
  const handleReset = () => {
    wavesurferRef.current?.stop();
    wavesurferRef.current?.seekTo(0);
  };

  return (
    <div className="relative w-full h-full flex flex-col">
      <div className="flex-1 relative flex items-center group">
        <div className="w-full relative py-8">
          <div ref={containerRef} className="w-full" />
          
          {/* Overlay markers for pacing gaps */}
          <div className="absolute inset-0 pointer-events-none z-10 flex items-center">
             <div className="w-full h-[140px] relative">
              {markers.map((marker) => (
                <div 
                  key={marker.key}
                  className="absolute top-0 bottom-0 border-l-2 border-accent/20 bg-accent/5 hover:bg-accent/10 transition-colors"
                  style={{ 
                    left: `${marker.leftPercent}%`,
                    width: `${Math.max(marker.widthPercent, 0.5)}%`
                  }}
                >
                  <div className="absolute -top-8 left-0 px-2 py-1 bg-background border border-panel-border scale-90 origin-left opacity-0 group-hover:opacity-100 transition-all">
                    <span className="text-[10px] text-accent font-bold whitespace-nowrap">
                      {marker.durationMs}ms gap
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {!isReady && localSources.length > 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 z-20">
            <span className="text-[10px] font-mono text-text-muted uppercase tracking-widest">Loading...</span>
          </div>
        )}
      </div>

      {/* Control Bar */}
      <div className="h-12 mt-3 border-t border-panel-border flex items-center justify-between px-1">
        <div className="flex items-center gap-6">
          <button 
            onClick={togglePlay}
            disabled={!isReady}
            className="w-10 h-10 rounded-full bg-accent text-white flex items-center justify-center hover:bg-accent/90 transition-all active:scale-90 disabled:opacity-20"
          >
            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-1" />}
          </button>
          <button 
            onClick={handleReset}
            disabled={!isReady}
            className="text-text-muted hover:text-text-main transition-colors disabled:opacity-20"
          >
            <RefreshCcw size={16} />
          </button>
        </div>

        <div className="flex items-center gap-10">
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-text-muted uppercase font-bold tracking-wider mb-1">Elapsed</span>
            <span className="text-sm text-text-main font-bold tabular-nums">00:00:00.000</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-text-muted uppercase font-bold tracking-wider mb-1">Events</span>
            <span className="text-sm text-text-main font-bold tracking-widest">{markers.length} Events detected</span>
          </div>
        </div>
      </div>

      {localSources.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-[10px] font-mono text-text-muted uppercase tracking-widest">No audio source</p>
        </div>
      )}
    </div>
  );
}
