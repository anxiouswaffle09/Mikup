import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Channel } from '@tauri-apps/api/core';
import type { DspCompletePayload } from '../types';
import { commands } from '@bindings';
import type { DspFramePayload } from '@bindings';

export interface UseDspStreamReturn {
  currentFrame: DspFramePayload | null;
  completePayload: DspCompletePayload | null;
  isStreaming: boolean;
  error: string | null;
  startStream: (dxPath: string, musicPath: string, effectsPath: string, startTimeSecs?: number, sourcePath?: string) => void;
  stopStream: () => void;
  seekStream: (timeSecs: number) => void;
}

export function useDspStream(): UseDspStreamReturn {
  const [currentFrame, setCurrentFrame] = useState<DspFramePayload | null>(null);
  const [completePayload, setCompletePayload] = useState<DspCompletePayload | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track unlisten fns so we can clean up on unmount.
  // We use a ref (not state) because we don't want cleanup changes to trigger re-renders.
  const unlistenersRef = useRef<Array<() => void>>([]);
  const channelRef = useRef<Channel<DspFramePayload> | null>(null);

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
        // Component unmounted before setup resolved — immediately clean up.
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
      // Stop any in-progress Rust stream so it doesn't burn CPU after unmount.
      commands.stopDspStream().catch(() => {});
    };
  }, []);

  function startStream(dxPath: string, musicPath: string, effectsPath: string, startTimeSecs?: number, sourcePath?: string) {
    setCurrentFrame(null);
    setCompletePayload(null);
    setError(null);
    setIsStreaming(true);

    const ch = new Channel<DspFramePayload>();
    ch.onmessage = (payload) => { setCurrentFrame(payload); };
    channelRef.current = ch;

    // Fire-and-forget: completion/errors come through Tauri events above.
    commands.streamAudioMetrics(ch, dxPath, musicPath, effectsPath, sourcePath ?? '', startTimeSecs ?? 0)
      .then((result) => {
        if (result.status === "error") {
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

  // Atomically move the Rust engine's read position without resetting any React state.
  // Intended for rapid-fire calls during waveform scrubbing. Safe to call even if no
  // stream is running — the stored seek value is discarded when the next stream starts.
  function seekStream(timeSecs: number) {
    commands.seekAudioStream(timeSecs).catch(() => {});
  }

  return { currentFrame, completePayload, isStreaming, error, startStream, stopStream, seekStream };
}
