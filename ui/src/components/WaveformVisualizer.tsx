import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, RefreshCcw } from 'lucide-react';
import type { DiagnosticEvent, PacingMikup } from '../types';

interface WaveformVisualizerProps {
  pacing?: PacingMikup[];
  duration?: number;
  audioSources?: string[];
  outputDir?: string;
  diagnosticEvents?: DiagnosticEvent[];
  onPlay?: (time: number) => void;
  onPause?: () => void;
  onSeek?: (time: number) => void;
  ghostStemPaths?: {
    musicPath?: string;
    sfxPath?: string;
    foleyPath?: string;
    ambiencePath?: string;
  };
  highlightAtSecs?: number | null;
}

const SEVERITY_STYLE: Record<string, { border: string; bg: string; label: string }> = {
  CRITICAL: { border: 'border-red-500/50',    bg: 'bg-red-500/15',    label: 'text-red-400' },
  HIGH:     { border: 'border-orange-500/50', bg: 'bg-orange-500/15', label: 'text-orange-400' },
  MEDIUM:   { border: 'border-yellow-500/50', bg: 'bg-yellow-500/15', label: 'text-yellow-400' },
  LOW:      { border: 'border-accent/30',     bg: 'bg-accent/8',      label: 'text-accent' },
};

const GHOST_STEMS = [
  { key: 'musicPath',    label: 'Music',    color: 'oklch(0.70 0.10 290)' },
  { key: 'sfxPath',      label: 'SFX',      color: 'oklch(0.75 0.16 65)'  },
  { key: 'foleyPath',    label: 'Foley',    color: 'oklch(0.70 0.14 22)'  },
  { key: 'ambiencePath', label: 'Ambience', color: 'oklch(0.55 0.06 220)' },
] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function toWaveSurferSource(path: string, outputDir?: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('file://') || trimmed.startsWith('asset://') || trimmed.startsWith('https://')) return trimmed;

  // Resolve relative paths to absolute using outputDir
  let resolved = trimmed;
  if (!resolved.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(resolved) && outputDir) {
    resolved = `${outputDir}/${resolved}`;
  }

  // Convert any absolute local path to a Tauri-safe asset URL
  if (resolved.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(resolved)) {
    try {
      const assetUrl = convertFileSrc(resolved);
      // convertFileSrc can return a non-throwing but malformed/empty string —
      // validate it is a well-formed URL before trusting it.
      if (assetUrl && /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/./.test(assetUrl)) {
        return assetUrl;
      }
    } catch {
      // Fall through to raw-path fallback
    }
    // Fallback: return the raw absolute path so WaveSurfer still has a chance to load.
    return resolved;
  }

  return resolved;
}

export function WaveformVisualizer({
  pacing,
  duration = 10,
  audioSources,
  outputDir,
  diagnosticEvents,
  onPlay,
  onPause,
  onSeek,
  ghostStemPaths,
  highlightAtSecs,
}: WaveformVisualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const loadSequenceRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  // Ghost wavesurfer refs
  const ghostWsRefs = useRef<(WaveSurfer | null)[]>([null, null, null, null]);
  const ghostContainerRefs = useRef<(HTMLDivElement | null)[]>([null, null, null, null]);

  // Stable refs so wavesurfer event handlers always call the latest callbacks
  // without needing to re-register listeners when props change.
  const onPlayRef = useRef(onPlay);
  const onPauseRef = useRef(onPause);
  const onSeekRef = useRef(onSeek);
  // Sync to latest props before any effects run this render.
  useLayoutEffect(() => {
    onPlayRef.current = onPlay;
    onPauseRef.current = onPause;
    onSeekRef.current = onSeek;
  });

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

  const eventMarkers = useMemo(() => {
    return (diagnosticEvents ?? []).map((evt, index) => {
      const startSecs = clamp(evt.timestamp_secs, 0, effectiveDuration);
      const durationSecs = clamp(evt.duration_secs, 0, effectiveDuration);
      const leftPercent = (startSecs / effectiveDuration) * 100;
      const widthPercent = clamp(
        (durationSecs / effectiveDuration) * 100,
        0.2,
        100 - leftPercent,
      );
      const style = SEVERITY_STYLE[evt.severity] ?? SEVERITY_STYLE.LOW;
      return { key: `${evt.timestamp_secs}-${evt.event_type}-${index}`, leftPercent, widthPercent, style, evt };
    });
  }, [diagnosticEvents, effectiveDuration]);

  // Main wavesurfer setup
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

    // Mute: Rust cpal handles audio output; wavesurfer is visual-only.
    ws.setVolume(0);

    ws.on('play', () => {
      setIsPlaying(true);
      onPlayRef.current?.(ws.getCurrentTime());
    });
    ws.on('pause', () => {
      setIsPlaying(false);
      onPauseRef.current?.();
    });
    ws.on('ready', () => setIsReady(true));
    ws.on('timeupdate', (time) => {
      setCurrentTime(time);
    });
    ws.on('interaction', () => {
      onSeekRef.current?.(ws.getCurrentTime());
      // Sync ghosts on seek interaction
      const t = ws.getCurrentTime();
      const dur = ws.getDuration();
      if (dur > 0) {
        for (const ghostWs of ghostWsRefs.current) {
          if (ghostWs) {
            ghostWs.seekTo(t / dur);
          }
        }
      }
    });

    // Sync ghost wavesurfers during playback
    ws.on('audioprocess', () => {
      const t = ws.getCurrentTime();
      const dur = ws.getDuration();
      if (dur > 0) {
        for (const ghostWs of ghostWsRefs.current) {
          if (ghostWs) {
            ghostWs.seekTo(t / dur);
          }
        }
      }
    });

    wavesurferRef.current = ws;

    return () => {
      ws.destroy();
      wavesurferRef.current = null;
    };
  }, []);

  // Ghost wavesurfer cleanup on unmount
  useEffect(() => {
    return () => {
      for (const ghostWs of ghostWsRefs.current) {
        ghostWs?.destroy();
      }
      ghostWsRefs.current = [null, null, null, null];
    };
  }, []);

  // Ghost wavesurfer init and audio loading when ghostStemPaths changes
  useEffect(() => {
    GHOST_STEMS.forEach(({ key, color }, i) => {
      const container = ghostContainerRefs.current[i];
      const path = ghostStemPaths?.[key];

      // Destroy existing ghost instance for this slot
      if (ghostWsRefs.current[i]) {
        ghostWsRefs.current[i]!.destroy();
        ghostWsRefs.current[i] = null;
      }

      if (!container || !path || !path.trim()) return;

      const ghostWs = WaveSurfer.create({
        container,
        waveColor: color,
        progressColor: color,
        cursorWidth: 0,
        barWidth: 1,
        barGap: 2,
        barRadius: 2,
        height: 30,
        hideScrollbar: true,
        normalize: true,
        interact: false,
      });

      ghostWs.setVolume(0);
      // Ghost stems are cosmetic overlays — a load failure must never surface or
      // interfere with the primary DX waveform.
      ghostWs.on('error', () => { /* fail silently */ });

      const resolvedPath = toWaveSurferSource(path, outputDir);
      ghostWs.load(resolvedPath);

      ghostWsRefs.current[i] = ghostWs;
    });
  }, [ghostStemPaths, outputDir]);

  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || localSources.length === 0) return;

    setIsReady(false); // eslint-disable-line react-hooks/set-state-in-effect
    const loadSequence = ++loadSequenceRef.current;

    const loadNextSource = (sourceIndex: number) => {
      if (sourceIndex >= localSources.length) return;

      const selectedSource = toWaveSurferSource(localSources[sourceIndex], outputDir);

      let handled = false;

      wavesurfer.once('ready', () => {
        if (handled) return;
        handled = true;
        if (loadSequence !== loadSequenceRef.current) return;
      });

      wavesurfer.once('error', () => {
        if (handled) return;
        handled = true;
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

          {/* Attention flare — key forces remount (animation restart) on each new timestamp */}
          {highlightAtSecs != null && (
            <div
              key={highlightAtSecs}
              className="absolute top-0 bottom-0 w-0.5 pointer-events-none z-20"
              style={{
                left: `${Math.max(0, Math.min(100, (highlightAtSecs / effectiveDuration) * 100))}%`,
                backgroundColor: 'oklch(0.75 0.16 65)',
                boxShadow: '0 0 8px oklch(0.75 0.16 65)',
                animation: 'flare-fade 1.5s ease-out forwards',
              }}
            />
          )}

          {/* Diagnostic event regions (below pacing markers in z-order) */}
          <div className="absolute inset-0 pointer-events-none z-[9] flex items-center">
            <div className="w-full h-[140px] relative">
              {eventMarkers.map((marker) => (
                <div
                  key={marker.key}
                  className={`absolute top-0 bottom-0 border-l-2 ${marker.style.border} ${marker.style.bg}`}
                  style={{
                    left: `${marker.leftPercent}%`,
                    width: `${Math.max(marker.widthPercent, 0.3)}%`,
                  }}
                >
                  <div className={`absolute -top-8 left-0 px-1.5 py-0.5 bg-background border border-panel-border scale-90 origin-left opacity-0 group-hover:opacity-100 transition-all`}>
                    <span className={`text-[9px] font-bold whitespace-nowrap uppercase tracking-wider ${marker.style.label}`}>
                      {marker.evt.event_type.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Pacing gap markers */}
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

        {/* Ghost waveforms */}
        {ghostStemPaths && (
          <div className="flex flex-col gap-0.5 mt-1 absolute left-0 right-0" style={{ top: 'calc(100% - 0.25rem)' }}>
            {GHOST_STEMS.map(({ key, label, color }, i) => {
              const path = ghostStemPaths[key];
              if (!path) return null;
              return (
                <div key={key} className="relative" style={{ opacity: 0.4 }}>
                  <div className="absolute left-0 top-0 z-10 px-1">
                    <span className="text-[8px] font-bold" style={{ color }}>{label}</span>
                  </div>
                  <div
                    ref={(el) => { ghostContainerRefs.current[i] = el; }}
                    className="w-full"
                    style={{ height: '30px' }}
                  />
                </div>
              );
            })}
          </div>
        )}

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
            <span className="text-sm text-text-main font-bold tabular-nums">{formatTime(currentTime)}</span>
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
