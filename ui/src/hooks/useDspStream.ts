import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { DspCompletePayload, DspFramePayload } from '../types';

export interface UseDspStreamReturn {
  currentFrame: DspFramePayload | null;
  completePayload: DspCompletePayload | null;
  isStreaming: boolean;
  error: string | null;
  startStream: (dialoguePath: string, backgroundPath: string) => void;
  stopStream: () => void;
}

export function useDspStream(): UseDspStreamReturn {
  const [currentFrame, setCurrentFrame] = useState<DspFramePayload | null>(null);
  const [completePayload, setCompletePayload] = useState<DspCompletePayload | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track unlisten fns so we can clean up on unmount.
  // We use a ref (not state) because we don't want cleanup changes to trigger re-renders.
  const unlistenersRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    let cleanedUp = false;

    const setup = async () => {
      const unlistenFrame = await listen<DspFramePayload>('dsp-frame', (event) => {
        if (!cleanedUp) setCurrentFrame(event.payload);
      });
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
        unlistenersRef.current = [unlistenFrame, unlistenComplete, unlistenError];
      } else {
        // Component unmounted before setup resolved — immediately clean up.
        unlistenFrame();
        unlistenComplete();
        unlistenError();
      }
    };

    setup();

    return () => {
      cleanedUp = true;
      unlistenersRef.current.forEach((fn) => fn());
      unlistenersRef.current = [];
      // Stop any in-progress Rust stream so it doesn't burn CPU after unmount.
      invoke<void>('stop_dsp_stream').catch(() => {});
    };
  }, []);

  const startStream = useCallback((dialoguePath: string, backgroundPath: string) => {
    setCurrentFrame(null);
    setCompletePayload(null);
    setError(null);
    setIsStreaming(true);
    // Fire-and-forget: completion/errors come through Tauri events above.
    invoke<void>('stream_audio_metrics', { dialoguePath, backgroundPath }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      setIsStreaming(false);
    });
  }, []);

  const stopStream = useCallback(() => {
    invoke<void>('stop_dsp_stream').catch(() => {
      // Best-effort; ignore errors from stop
    });
    setIsStreaming(false);
  }, []);

  return { currentFrame, completePayload, isStreaming, error, startStream, stopStream };
}
