import { useEffect, useRef } from 'react';

interface VectorscopeProps {
  /** Lissajous X/Y pairs in [-1, 1] range. Max 128 points per frame from Rust. */
  lissajousPoints: [number, number][];
  /** Canvas size in px (renders as a square). Default: 200. */
  size?: number;
}

const NEON_GREEN = '#39ff14';
const GUIDE_COLOR = 'rgba(255, 255, 255, 0.06)';
const CROSS_COLOR = 'rgba(255, 255, 255, 0.10)';
const BACKGROUND = '#0a0a0a';

export function Vectorscope({ lissajousPoints, size = 200 }: VectorscopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Cancel any pending frame before scheduling a new one.
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    rafRef.current = requestAnimationFrame(() => {
      if (!lissajousPoints || lissajousPoints.length === 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgb(10, 10, 10)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }

      const cx = size / 2;
      const cy = size / 2;
      const radius = cx * 0.88;

      // Persistence effect (motion blur): Draw semi-transparent background
      // instead of clearing entirely to let old frames fade.
      ctx.fillStyle = "rgba(10, 10, 10, 0.25)";
      ctx.fillRect(0, 0, size, size);

      // Outer guide circle
      ctx.strokeStyle = GUIDE_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Center cross
      ctx.strokeStyle = CROSS_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.stroke();

      // Lissajous points
      ctx.shadowBlur = 8;
      ctx.shadowColor = NEON_GREEN;
      ctx.fillStyle = NEON_GREEN;

      for (const [x, y] of lissajousPoints) {
        // x/y are in [-1, 1]. Map to canvas pixel coords.
        const px = cx + x * radius;
        const py = cy - y * radius; // flip Y: canvas y grows downward
        ctx.beginPath();
        ctx.arc(px, py, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Reset shadow so it doesn't bleed onto the next paint
      ctx.shadowBlur = 0;
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [lissajousPoints, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      aria-label="Vectorscope goniometer"
      style={{ display: 'block', background: BACKGROUND }}
    />
  );
}
