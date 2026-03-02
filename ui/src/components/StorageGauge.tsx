import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DiskInfo } from '../types';

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

interface StorageGaugeProps {
  workspacePath: string;
  /** Bump this timestamp to trigger a re-query (e.g. after a stage completes). */
  lastUpdated?: number;
}

export function StorageGauge({ workspacePath, lastUpdated }: StorageGaugeProps) {
  const [diskInfo, setDiskInfo] = useState<DiskInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspacePath.trim()) return;
    invoke<DiskInfo>('get_disk_info', { path: workspacePath })
      .then((info) => {
        setDiskInfo(info);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(String(err));
      });
  }, [workspacePath, lastUpdated]);

  if (!workspacePath.trim()) return null;

  if (error) {
    return (
      <div className="px-4 py-3 border-t border-panel-border">
        <p className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">
          Storage
        </p>
        <p className="text-[10px] font-mono text-text-muted opacity-50">—</p>
      </div>
    );
  }

  if (!diskInfo) {
    return (
      <div className="px-4 py-3 border-t border-panel-border">
        <p className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-1">
          Storage
        </p>
        <div className="h-1.5 bg-panel-border rounded-full animate-pulse" />
      </div>
    );
  }

  const usedPct = diskInfo.total_bytes > 0 ? diskInfo.used_bytes / diskInfo.total_bytes : 0;
  // oklch color ramp: accent → amber at 70% → red at 90%
  const barColor =
    usedPct >= 0.9
      ? 'oklch(0.55 0.22 25)'
      : usedPct >= 0.7
        ? 'oklch(0.75 0.18 80)'
        : 'var(--color-accent)';

  return (
    <div className="px-4 py-3 border-t border-panel-border">
      <p className="text-[9px] uppercase tracking-widest font-bold text-text-muted mb-2">
        Storage
      </p>
      <div className="h-1.5 bg-panel-border rounded-full overflow-hidden mb-1.5">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${(usedPct * 100).toFixed(1)}%`, backgroundColor: barColor }}
        />
      </div>
      <div className="flex justify-between text-[9px] font-mono text-text-muted">
        <span>{formatBytes(diskInfo.used_bytes)} used</span>
        <span>{formatBytes(diskInfo.available_bytes)} free</span>
      </div>
    </div>
  );
}
