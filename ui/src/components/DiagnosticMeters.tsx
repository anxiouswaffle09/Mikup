import React from 'react';
import type { DiagnosticMetrics } from '../types';

interface StatsBarProps {
  metrics: DiagnosticMetrics;
  eventCount: number;
  integratedLufs: number | null;
}

export const StatsBar: React.FC<StatsBarProps> = ({ metrics, eventCount, integratedLufs }) => {
  return (
    <div className="border-t border-b border-panel-border py-4 grid grid-cols-2 md:grid-cols-5 gap-x-6 gap-y-4">
      <StatCell
        label="SNR"
        value={metrics.intelligibility_snr}
        unit="dB"
        min={-10}
        max={40}
        interpret={interpretSnr(metrics.intelligibility_snr)}
        targetLabel="Target > 15 dB"
        targets={[15]}
      />
      <StatCell
        label="Phase Correlation"
        value={metrics.stereo_correlation}
        unit=""
        min={-1}
        max={1}
        interpret={interpretCorr(metrics.stereo_correlation)}
        targetLabel="Target > 0.5"
        targets={[0.5]}
      />
      <StatCell
        label="Stereo Balance"
        value={metrics.stereo_balance}
        unit=""
        min={-1}
        max={1}
        interpret={interpretBalance(metrics.stereo_balance)}
        targetLabel="Target ±0.1"
        targets={[-0.1, 0.1]}
      />
      <StatCell
        label="Events Detected"
        value={eventCount}
        unit=""
        min={0}
        max={100}
        interpret=""
        hideBar
      />
      <StatCell
        label="Integrated LUFS"
        value={integratedLufs ?? 0}
        unit="LUFS"
        min={-48}
        max={0}
        interpret={integratedLufs !== null ? '' : 'N/A'}
        hideBar={integratedLufs === null}
        decimals={2}
      />
    </div>
  );
};

interface StatCellProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  interpret: string;
  hideBar?: boolean;
  decimals?: number;
  targets?: number[];
  targetLabel?: string;
}

const StatCell: React.FC<StatCellProps> = ({ label, value, unit, min, max, interpret, hideBar, decimals, targets, targetLabel }) => {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const safeTargets = (targets ?? [])
    .map((target) => Math.max(0, Math.min(1, (target - min) / (max - min))));
  const precision = typeof decimals === 'number' ? decimals : value % 1 === 0 ? 0 : 2;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">{label}</span>
      <span className="font-mono text-xl font-semibold text-text-main tabular-nums leading-none">
        {typeof value === 'number' ? value.toFixed(precision) : '--'}
        {unit && <span className="text-xs font-normal text-text-muted ml-1">{unit}</span>}
      </span>
      {!hideBar && (
        <div className="h-px w-full bg-panel-border relative mt-1">
          {safeTargets.map((targetPos, index) => (
            <div
              key={`${label}-target-${index}`}
              className="absolute top-[-1px] h-[3px] w-[1px] bg-[oklch(0.65_0.14_20)]"
              style={{ left: `${targetPos * 100}%` }}
            />
          ))}
          <div
            className="absolute top-0 left-0 h-px bg-accent transition-all duration-700"
            style={{ width: `${pct * 100}%` }}
          />
        </div>
      )}
      {interpret && (
        <span className="text-[9px] text-text-muted font-medium mt-0.5">{interpret}</span>
      )}
      {targetLabel && !hideBar && (
        <span className="text-[9px] text-text-muted/80 font-medium">{targetLabel}</span>
      )}
    </div>
  );
};

function interpretSnr(v: number) {
  if (v > 25) return 'Excellent Clarity';
  if (v > 15) return 'Clear Dialogue';
  if (v > 5) return 'Competitive Mix';
  return 'Poor Separation';
}

function interpretCorr(v: number) {
  if (v > 0.8) return 'Strong Mono Compat.';
  if (v > 0.3) return 'Healthy Stereo';
  if (v >= 0) return 'Wide Field';
  return 'Phase Issues';
}

function interpretBalance(v: number) {
  if (Math.abs(v) < 0.1) return 'Centered';
  if (v > 0) return 'Biased Right';
  return 'Biased Left';
}
