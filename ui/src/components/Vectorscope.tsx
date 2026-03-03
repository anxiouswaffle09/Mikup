import { memo, useEffect, useRef } from 'react';
import type { DspFramePayload } from '@bindings';

interface VectorscopeProps {
  latestFrameRef: React.MutableRefObject<DspFramePayload | null>;
  /** Whether the stream is active — starts/stops the RAF loop. */
  isStreaming: boolean;
  /** Canvas size in px (renders as a square). Default: 200. */
  size?: number;
}

const NEON_GREEN = '#39ff14';
const GUIDE_COLOR = 'rgba(255, 255, 255, 0.06)';
const CROSS_COLOR = 'rgba(255, 255, 255, 0.10)';

export const Vectorscope = memo(function Vectorscope({ latestFrameRef, isStreaming, size = 200 }: VectorscopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cx = size / 2;
    const cy = size / 2;
    const radius = cx * 0.88;

    const paintGuides = () => {
      ctx.strokeStyle = GUIDE_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = CROSS_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.stroke();
    };

    if (!isStreaming) {
      // Stop the RAF loop; leave the last painted frame visible on canvas.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    // Starting (or restarting) the stream — paint a clean slate first.
    ctx.fillStyle = 'rgb(10, 10, 10)';
    ctx.fillRect(0, 0, size, size);
    paintGuides();

    const loop = () => {
      const frame = latestFrameRef.current;
      const points = frame?.lissajous_points;

      // Persistence effect: semi-transparent overlay fades previous frame.
      ctx.fillStyle = 'rgba(10, 10, 10, 0.25)';
      ctx.fillRect(0, 0, size, size);

      paintGuides();

      if (points && points.length > 0) {
        ctx.shadowBlur = 8;
        ctx.shadowColor = NEON_GREEN;
        ctx.fillStyle = NEON_GREEN;

        for (const [x, y] of points) {
          const px = cx + x * radius;
          const py = cy - y * radius;
          ctx.beginPath();
          ctx.arc(px, py, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.shadowBlur = 0;
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isStreaming, latestFrameRef, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      aria-label="Vectorscope goniometer"
      className="block bg-console-bg"
    />
  );
});
