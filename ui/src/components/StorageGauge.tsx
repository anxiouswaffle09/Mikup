import { useEffect, useState } from 'react';
import { commands } from '@bindings';
import { AlertCircle, Trash2 } from 'lucide-react';
import type { DiskInfo } from '../types';

const CRITICAL_THRESHOLD_BYTES = 5 * 1e9; // 5 GB

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
    commands.getDiskInfo(workspacePath)
      .then((result) => {
        if (result.status === 'error') { setError(result.error); return; }
        setDiskInfo(result.data);
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

  const isCritical = diskInfo.available_bytes < CRITICAL_THRESHOLD_BYTES;
  const usedPct = diskInfo.total_bytes > 0 ? diskInfo.used_bytes / diskInfo.total_bytes : 0;

  const barColor = isCritical
    ? 'oklch(0.55 0.22 25)'
    : usedPct >= 0.9
      ? 'oklch(0.55 0.22 25)'
      : usedPct >= 0.7
        ? 'oklch(0.75 0.18 80)'
        : 'var(--color-accent)';

  function handleOpenPath() {
    commands.openPath(workspacePath).catch(console.error);
  }

  return (
    <div className="group px-4 py-3 border-t border-panel-border relative">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <p className="text-[9px] uppercase tracking-widest font-bold text-text-muted">
            Storage
          </p>
          {isCritical && (
            <AlertCircle
              size={10}
              className="text-red-500 shrink-0"
              aria-label="Critical: disk space low"
            />
          )}
        </div>

        {/* Trash icon — visible on hover */}
        <button
          onClick={handleOpenPath}
          title="Open workspace folder to free space"
          className="
            opacity-0 group-hover:opacity-100
            transition-opacity duration-200
            rounded p-0.5
            hover:bg-white/10
            backdrop-blur-sm
            text-text-muted hover:text-white
            cursor-pointer
          "
          aria-label="Open workspace in file explorer"
        >
          <Trash2 size={10} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-panel-border rounded-full overflow-hidden mb-1.5">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${(usedPct * 100).toFixed(1)}%`, backgroundColor: barColor }}
        />
      </div>

      {/* Stats row */}
      <div className="flex justify-between text-[9px] font-mono text-text-muted">
        <span>{formatBytes(diskInfo.used_bytes)} used</span>
        <span>{formatBytes(diskInfo.available_bytes)} free</span>
      </div>

      {/* Critical warning */}
      {isCritical && (
        <p className="mt-1 text-[9px] font-mono text-red-500">
          Critical: Space low for separation
        </p>
      )}
    </div>
  );
}
