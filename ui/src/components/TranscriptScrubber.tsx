import { useEffect, useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import type { TranscriptionSegment, WordSegment } from '../types';

interface TranscriptScrubberProps {
  segments: TranscriptionSegment[];
  wordSegments: WordSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
}

export function TranscriptScrubber({
  segments,
  wordSegments,
  currentTime,
  onSeek,
}: TranscriptScrubberProps) {
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Determine which segment is currently active
  const activeSegmentIdx = useMemo(
    () => segments.findIndex((seg) => currentTime >= seg.start && currentTime <= seg.end),
    [segments, currentTime],
  );

  // Pre-bucket word segments by segment index for O(1) lookup per render
  const wordsBySegment = useMemo(() => {
    const map = new Map<number, WordSegment[]>();
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      map.set(
        i,
        wordSegments.filter((w) => w.start >= seg.start && w.start < seg.end),
      );
    }
    return map;
  }, [segments, wordSegments]);

  // Auto-scroll active segment into view
  useEffect(() => {
    if (activeSegmentIdx < 0) return;
    segmentRefs.current[activeSegmentIdx]?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [activeSegmentIdx]);

  if (segments.length === 0) {
    return (
      <p className="text-[10px] font-mono text-text-muted uppercase tracking-widest">
        No transcription data
      </p>
    );
  }

  return (
    <div className="overflow-y-auto max-h-full pr-1 space-y-5 scrollbar-thin">
      {segments.map((seg, segIdx) => {
        const words = wordsBySegment.get(segIdx) ?? [];
        const isActiveSegment = segIdx === activeSegmentIdx;

        return (
          <div
            key={`${seg.start}-${segIdx}`}
            ref={(el) => { segmentRefs.current[segIdx] = el; }}
            className={clsx(
              'transition-opacity duration-300',
              activeSegmentIdx >= 0 && !isActiveSegment && 'opacity-40',
            )}
          >
            {/* Speaker label */}
            {seg.speaker && (
              <p className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1.5 font-mono">
                {seg.speaker}
              </p>
            )}

            {/* Word-level rendering when word segments are available */}
            {words.length > 0 ? (
              <p className="font-serif text-sm leading-relaxed text-text-main">
                {words.map((word, wIdx) => {
                  const isActiveWord =
                    currentTime >= word.start && currentTime <= word.end;
                  return (
                    <span key={`${word.start}-${wIdx}`}>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={() => onSeek(word.start)}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSeek(word.start)}
                        className={clsx(
                          'cursor-pointer rounded-sm px-0.5 transition-colors duration-75',
                          isActiveWord
                            ? 'bg-accent/20 text-accent'
                            : 'hover:bg-accent/10 hover:text-accent',
                        )}
                      >
                        {word.word}
                      </span>
                      {' '}
                    </span>
                  );
                })}
              </p>
            ) : (
              /* Fallback: segment-level click when no word segments exist */
              <p
                role="button"
                tabIndex={0}
                onClick={() => onSeek(seg.start)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSeek(seg.start)}
                className={clsx(
                  'font-serif text-sm leading-relaxed text-text-main cursor-pointer rounded-sm px-0.5',
                  'hover:bg-accent/10 hover:text-accent transition-colors',
                  isActiveSegment && 'text-accent',
                )}
              >
                {seg.text}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
