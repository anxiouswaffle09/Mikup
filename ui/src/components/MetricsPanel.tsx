import React, { useState, useMemo } from 'react';
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Label, Area, AreaChart
} from 'recharts';
import type { MikupPayload } from '../types';
import { Activity, Info } from 'lucide-react';
import { clsx } from 'clsx';

interface MetricsPanelProps {
  payload: MikupPayload;
}

interface GraphDataPoint {
  time: number;
  timeStr: string;
  diagM: number;
  diagST: number;
  bgM: number;
  bgST: number;
}

export const MetricsPanel: React.FC<MetricsPanelProps> = ({ payload }) => {
  const [activeStreams, setActiveStreams] = useState<Set<string>>(new Set(['diagST', 'bgST']));
  const [flags, setFlags] = useState<{ time: number; label: string }[]>([]);
  
  const graphData = useMemo(() => {
    const lufs = payload.metrics?.lufs_graph;
    if (!lufs) return [];

    const diag = lufs.dialogue_raw;
    const bg = lufs.background_raw;
    if (!diag && !bg) return [];

    const maxLen = Math.max(diag?.momentary.length ?? 0, bg?.momentary.length ?? 0);
    const data: GraphDataPoint[] = [];

    // Assuming 2 data points per second (hop_length=11025 at 22050Hz)
    for (let i = 0; i < maxLen; i++) {
      const time = i / 2.0;
      data.push({
        time,
        timeStr: `${Math.floor(time / 60)}:${Math.floor(time % 60).toString().padStart(2, '0')}`,
        diagM: diag?.momentary[i] ?? -70,
        diagST: diag?.short_term[i] ?? -70,
        bgM: bg?.momentary[i] ?? -70,
        bgST: bg?.short_term[i] ?? -70,
      });
    }
    return data;
  }, [payload.metrics?.lufs_graph]);

  const toggleStream = (stream: string) => {
    setActiveStreams(prev => {
      const next = new Set(prev);
      if (next.has(stream)) next.delete(stream);
      else next.add(stream);
      return next;
    });
  };

  type ChartClickHandler = NonNullable<React.ComponentProps<typeof AreaChart>['onClick']>;
  const handleGraphClick = (data: Parameters<ChartClickHandler>[0]) => {
    const d = data as { activePayload?: Array<{ payload: GraphDataPoint }> } | null;
    if (d?.activePayload?.[0]) {
      const point = d.activePayload[0].payload;
      const label = `Flag at ${point.timeStr}`;
      setFlags([...flags, { time: point.time, label }]);
    }
  };

  if (!payload.metrics?.lufs_graph) {
    return (
      <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-panel-border rounded-3xl bg-background/50">
        <Activity size={48} className="text-text-muted/20 mb-4" />
        <p className="text-text-muted font-medium italic">LUFS Graph data not available for this session.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-700">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-2">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-2xl bg-accent/10 text-accent">
            <Activity size={20} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-text-main leading-tight">LUFS Laboratory</h3>
            <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted">EBU R128 Density Mapping</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <StreamToggle 
            label="Dialogue" 
            color="oklch(0.7 0.12 260)" // Blue
            isActive={activeStreams.has('diagST')}
            onClick={() => toggleStream('diagST')}
          />
          <StreamToggle 
            label="Background" 
            color="oklch(0.7 0.12 150)" // Green
            isActive={activeStreams.has('bgST')}
            onClick={() => toggleStream('bgST')}
          />
          <StreamToggle 
            label="Momentary" 
            color="oklch(0.7 0.12 300)" // Purple
            isActive={activeStreams.has('diagM') || activeStreams.has('bgM')}
            onClick={() => {
              toggleStream('diagM');
              toggleStream('bgM');
            }}
          />
        </div>
      </div>

      <div className="panel p-6 h-[380px] relative overflow-hidden group">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={graphData}
            onClick={handleGraphClick}
            margin={{ top: 20, right: 10, left: -20, bottom: 0 }}
          >
            <defs>
              <linearGradient id="colorDiag" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.7 0.12 260)" stopOpacity={0.15}/>
                <stop offset="95%" stopColor="oklch(0.7 0.12 260)" stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="colorBg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.7 0.12 150)" stopOpacity={0.15}/>
                <stop offset="95%" stopColor="oklch(0.7 0.12 150)" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="oklch(0.9 0.01 250)" />
            <XAxis 
              dataKey="time" 
              hide={true}
            />
            <YAxis 
              domain={[-60, 0]} 
              ticks={[-60, -48, -36, -24, -12, 0]}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 9, fill: 'oklch(0.5 0.01 250)', fontWeight: 700 }}
            />
            <Tooltip 
              content={<CustomTooltip />}
              cursor={{ stroke: 'oklch(0.7 0.12 260)', strokeWidth: 1, strokeDasharray: '4 4' }}
            />
            
            {activeStreams.has('diagST') && (
              <Area 
                type="monotone" 
                dataKey="diagST" 
                stroke="oklch(0.7 0.12 260)" 
                strokeWidth={2.5}
                fillOpacity={1} 
                fill="url(#colorDiag)" 
                animationDuration={1500}
              />
            )}
            {activeStreams.has('bgST') && (
              <Area 
                type="monotone" 
                dataKey="bgST" 
                stroke="oklch(0.7 0.12 150)" 
                strokeWidth={2}
                fillOpacity={1} 
                fill="url(#colorBg)" 
                animationDuration={1500}
              />
            )}
            
            {activeStreams.has('diagM') && (
              <Line 
                type="monotone" 
                dataKey="diagM" 
                stroke="oklch(0.7 0.12 260)" 
                strokeWidth={1} 
                dot={false} 
                strokeOpacity={0.3}
              />
            )}
            {activeStreams.has('bgM') && (
              <Line 
                type="monotone" 
                dataKey="bgM" 
                stroke="oklch(0.7 0.12 150)" 
                strokeWidth={1} 
                dot={false} 
                strokeOpacity={0.3}
              />
            )}

            <ReferenceLine y={-23} stroke="oklch(0.8 0.1 350)" strokeDasharray="3 3">
              <Label value="TARGET (-23)" position="insideTopRight" fill="oklch(0.8 0.1 350)" fontSize={8} fontWeight={900} />
            </ReferenceLine>

            {flags.map((flag, i) => (
              <ReferenceLine 
                key={i} 
                x={flag.time} 
                stroke="oklch(0.7 0.12 300)" 
                strokeWidth={2}
              >
                <Label content={<FlagLabel label={flag.label} />} />
              </ReferenceLine>
            ))}
          </AreaChart>
        </ResponsiveContainer>

        {/* Floating Metrics Overlay */}
        <div className="absolute bottom-6 right-8 flex items-center gap-6 bg-white/60 backdrop-blur-xl px-5 py-3 rounded-2xl border border-panel-border shadow-xl ring-1 ring-black/[0.03]">
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-widest font-black text-text-muted mb-0.5">Integrated</span>
            <span className="text-xl font-black text-text-main tracking-tighter">
              {payload.metrics?.lufs_graph?.dialogue_raw?.integrated.toFixed(1) ?? '--'} <span className="text-xs font-medium text-text-muted">LUFS</span>
            </span>
          </div>
          <div className="w-px h-8 bg-panel-border/60" />
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-widest font-black text-text-muted mb-0.5">Peak S.Term</span>
            <span className="text-xl font-black text-text-main tracking-tighter">
              {graphData.length > 0 ? Math.max(...graphData.map(d => d.diagST)).toFixed(1) : '--'}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-4 p-4 rounded-2xl bg-accent/5 border border-accent/10 transition-all hover:bg-accent/10">
        <div className="p-2 rounded-xl bg-white shadow-sm text-accent shrink-0">
          <Info size={16} />
        </div>
        <p className="text-[11px] text-text-muted leading-relaxed font-medium">
          <span className="font-black text-accent uppercase tracking-wider mr-1">Laboratory Note:</span> 
          The graph above maps perceived loudness density over time. <strong>Short-term (3s)</strong> provides a stable view of structural dynamics, while <strong>Momentary (400ms)</strong> captures surgical transients. Click to place analysis anchors.
        </p>
      </div>
    </div>
  );
};

const StreamToggle: React.FC<{ label: string; color: string; isActive: boolean; onClick: () => void }> = ({ 
  label, color, isActive, onClick 
}) => (
  <button 
    onClick={onClick}
    className={clsx(
      "px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all duration-500 flex items-center gap-2",
      isActive 
        ? "bg-white shadow-md border-panel-border scale-105" 
        : "opacity-30 grayscale border-transparent hover:opacity-100 hover:grayscale-0"
    )}
    style={{ color: isActive ? color : undefined }}
  >
    <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
    {label}
  </button>
);

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: GraphDataPoint }>;
}

const CustomTooltip = ({ active, payload }: CustomTooltipProps) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-white/95 backdrop-blur-2xl border border-panel-border p-4 rounded-2xl shadow-2xl ring-1 ring-black/[0.05] space-y-3">
        <div className="text-[10px] font-black text-text-muted uppercase tracking-[0.2em] border-b border-panel-border pb-2">{data.timeStr}</div>
        <div className="space-y-2">
          <TooltipRow label="Dialogue" value={data.diagST} color="oklch(0.7 0.12 260)" />
          <TooltipRow label="Background" value={data.bgST} color="oklch(0.7 0.12 150)" />
        </div>
      </div>
    );
  }
  return null;
};

const TooltipRow = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div className="flex items-center justify-between gap-8">
    <div className="flex items-center gap-2.5">
      <div className="w-2 h-2 rounded-full shadow-sm" style={{ backgroundColor: color }} />
      <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{label}</span>
    </div>
    <span className="text-sm font-black text-text-main tracking-tighter">{value.toFixed(1)} <span className="text-[9px] font-medium text-text-muted">dB</span></span>
  </div>
);

const FlagLabel = ({ label }: { label: string }) => (
  <g transform="translate(0, -10)">
    <rect x="-45" y="-22" width="90" height="22" rx="6" fill="oklch(0.7 0.12 300)" className="shadow-lg" />
    <text x="0" y="-7" textAnchor="middle" fill="white" fontSize="9" fontWeight="900" letterSpacing="0.05em">
      {label.toUpperCase()}
    </text>
  </g>
);
