import React, { useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';

interface WaveformProps {
  transcription?: any;
  pacing?: any[];
}

export function WaveformVisualizer({ transcription, pacing, duration = 10 }: { transcription?: any, pacing?: any[], duration?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    wavesurferRef.current = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#3a3a3d',
      progressColor: '#5a5ae6',
      cursorColor: '#5a5ae6',
      barWidth: 2,
      barGap: 3,
      height: 120,
      hideScrollbar: true,
    });

    // In a real app, this would be the URL to the local stem file
    wavesurferRef.current.load('https://www.mfiles.co.uk/mp3-downloads/gs-cd-track2.mp3');

    return () => {
      wavesurferRef.current?.destroy();
    };
  }, []);

  return (
    <div className="relative w-full h-full flex flex-col justify-center">
      <div ref={containerRef} className="w-full" />
      
      {/* Overlay markers for pacing gaps */}
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none">
        {pacing?.map((gap, i) => (
          <div 
            key={i}
            className="absolute top-0 bottom-0 border-l border-dashed border-accent/40 bg-accent/5"
            style={{ 
              left: `${(gap.timestamp / duration) * 100}%`, 
              width: `${(gap.duration_ms / (duration * 1000)) * 100}%` 
            }}
          >
            <span className="text-[8px] text-accent absolute -top-1 px-1 bg-background whitespace-nowrap">
              {gap.duration_ms}ms
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
