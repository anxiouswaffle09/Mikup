import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Channel } from '@tauri-apps/api/core';
import type { DspCompletePayload } from '../types';
import { commands } from '@bindings';
import type { DspFramePayload } from '@bindings';

export interface UseDspStreamReturn {
  /** Ref to the most recent frame — mutated at 60Hz, never causes re-renders. */
  latestFrameRef: React.MutableRefObject<DspFramePayload | null>;
  /** Throttled timestamp (~15Hz) — safe to use as React state for the playhead. */
  currentTimeSecs: number;
  completePayload: DspCompletePayload | null;
  isStreaming: boolean;
  error: string | null;
  startStream: (dxPath: string, musicPath: string, effectsPath: string, startTimeSecs?: number, sourcePath?: string) => void;
  stopStream: () => void;
  seekStream: (timeSecs: number) => void;
}

export function useDspStream(): UseDspStreamReturn {
  const latestFrameRef = useRef<DspFramePayload | null>(null);
  const [currentTimeSecs, setCurrentTimeSecs] = useState(0);
  const [completePayload, setCompletePayload] = useState<DspCompletePayload | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlistenersRef = useRef<Array<() => void>>([]);
  const channelRef = useRef<Channel<DspFramePayload> | null>(null);
  const lastTimeUpdateRef = useRef<number>(0);

  useEffect(() => {
    let cleanedUp = false;

    const setup = async () => {
      const unlistenComplete = await listen<DspCompletePayload>('dsp-complete', (event) => {
        if (!cleanedUp) {
          setCompletePayload(event.payload);
          setIsStreaming(false);
        }
      });
      const unlistenError = await listen<string>('dsp-error', (event) => {
        if (!cleanedUp) {
          setError(event.payload);
          setIsStreaming(false);
        }
      });

      if (!cleanedUp) {
        unlistenersRef.current = [unlistenComplete, unlistenError];
      } else {
        unlistenComplete();
        unlistenError();
      }
    };

    setup();

    return () => {
      cleanedUp = true;
      unlistenersRef.current.forEach((fn) => fn());
      unlistenersRef.current = [];
      channelRef.current = null;
      latestFrameRef.current = null;
      commands.stopDspStream().catch(() => {});
    };
  }, []);

  function startStream(dxPath: string, musicPath: string, effectsPath: string, startTimeSecs?: number, sourcePath?: string) {
    latestFrameRef.current = null;
    setCurrentTimeSecs(startTimeSecs ?? 0);
    setCompletePayload(null);
    setError(null);
    setIsStreaming(true);

    const ch = new Channel<DspFramePayload>();
    ch.onmessage = (payload) => {
      // Always write to ref — zero state updates on the hot path.
      latestFrameRef.current = payload;
      // Throttle: update currentTimeSecs at ~15Hz only.
      const now = Date.now();
      if (now - lastTimeUpdateRef.current > 66) {
        lastTimeUpdateRef.current = now;
        setCurrentTimeSecs(payload.timestamp_secs);
      }
    };
    channelRef.current = ch;

    commands.streamAudioMetrics(ch, dxPath, musicPath, effectsPath, sourcePath ?? '', startTimeSecs ?? 0)
      .then((result) => {
        if (result.status === 'error') {
          setError(result.error);
          setIsStreaming(false);
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setIsStreaming(false);
      });
  }

  function stopStream() {
    commands.stopDspStream().catch(() => {});
    setIsStreaming(false);
  }

  function seekStream(timeSecs: number) {
    commands.seekAudioStream(timeSecs).catch(() => {});
  }

  return { latestFrameRef, currentTimeSecs, completePayload, isStreaming, error, startStream, stopStream, seekStream };
}
