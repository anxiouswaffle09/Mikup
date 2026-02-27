import React from 'react';
import type { DiagnosticMetrics } from '../types';
import { Activity, ShieldCheck, Zap } from 'lucide-react';

interface DiagnosticMetersProps {
  metrics: DiagnosticMetrics;
}

export const DiagnosticMeters: React.FC<DiagnosticMetersProps> = ({ metrics }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <MeterCard 
        label="Intelligibility (SNR)" 
        value={metrics.intelligibility_snr} 
        min={-10} 
        max={40} 
        unit="dB"
        icon={<ShieldCheck size={18} />}
        color="oklch(0.7 0.12 150)" // Pastel Green
      />
      <MeterCard 
        label="Phase Correlation" 
        value={metrics.stereo_correlation} 
        min={-1} 
        max={1} 
        unit=""
        icon={<Activity size={18} />}
        color="oklch(0.7 0.12 260)" // Pastel Blue
      />
      <MeterCard 
        label="Stereo Balance" 
        value={metrics.stereo_balance} 
        min={-1} 
        max={1} 
        unit=""
        icon={<Zap size={18} />}
        color="oklch(0.7 0.12 300)" // Pastel Purple
      />
    </div>
  );
};

interface MeterCardProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  icon: React.ReactNode;
  color: string;
}

const MeterCard: React.FC<MeterCardProps> = ({ label, value, min, max, unit, icon, color }) => {
  // Normalize value for needle rotation (0 to 180 degrees)
  const normalized = Math.max(min, Math.min(max, value));
  const percentage = (normalized - min) / (max - min);
  const rotation = -90 + (percentage * 180);

  return (
    <div className="panel p-6 flex flex-col items-center group">
      <div className="flex items-center gap-2 text-text-muted mb-6 w-full">
        <div className="text-accent">{icon}</div>
        <span className="text-sm font-medium">{label}</span>
      </div>

      <div className="relative w-48 h-24 mb-4 overflow-hidden">
        {/* Meter Arc */}
        <svg viewBox="0 0 100 50" className="w-full h-full">
          <path
            d="M 10 45 A 35 35 0 0 1 90 45"
            fill="none"
            stroke="var(--color-panel-border)"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <path
            d="M 10 45 A 35 35 0 0 1 90 45"
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray="125.66"
            strokeDashoffset={125.66 * (1 - percentage)}
            className="transition-all duration-1000 ease-out"
          />
        </svg>

        {/* Needle */}
        <div 
          className="absolute bottom-0 left-1/2 w-0.5 h-12 bg-text-main origin-bottom transition-transform duration-1000 ease-out"
          style={{ transform: `translateX(-50%) rotate(${rotation}deg)` }}
        >
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-text-main" />
        </div>

        {/* Center Point */}
        <div className="absolute bottom-[-4px] left-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-text-main border-4 border-panel shadow-sm" />
      </div>

      <div className="text-center mt-2">
        <span className="text-3xl font-bold text-text-main tracking-tight">
          {value.toFixed(1)}
        </span>
        <span className="text-sm font-medium text-text-muted ml-1">{unit}</span>
      </div>
      
      {/* Dynamic Interpretation Tag */}
      <div className="mt-4 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest bg-background border border-panel-border text-text-muted group-hover:border-accent/40 group-hover:text-accent transition-all duration-500">
        {getInterpretation(label, value)}
      </div>
    </div>
  );
};

function getInterpretation(label: string, value: number): string {
  if (label.includes("SNR")) {
    if (value > 25) return "Excellent Clarity";
    if (value > 15) return "Clear Dialogue";
    if (value > 5) return "Competitive Mix";
    return "Poor Separation";
  }
  if (label.includes("Correlation")) {
    if (value > 0.8) return "Strong Mono Compatibility";
    if (value > 0.3) return "Healthy Stereo";
    if (value >= 0) return "Wide Field";
    return "Phase Issues Detected";
  }
  if (label.includes("Balance")) {
    if (Math.abs(value) < 0.1) return "Perfectly Centered";
    if (value > 0) return "Biased Right";
    return "Biased Left";
  }
  return "Stable";
}
