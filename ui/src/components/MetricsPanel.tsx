import React, { useMemo, useState } from 'react';
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Label, Area, AreaChart, Brush
} from 'recharts';
import type { MikupPayload } from '../types';
import { Activity } from 'lucide-react';
import { clsx } from 'clsx';

interface MetricsPanelProps {
  payload: MikupPayload;
  loudnessTarget: {
    label: string;
    value: number;
  };
}

interface GraphDataPoint {
  time: number;
  timeStr: string;
  diagM: number;
  diagST: number;
  bgM: number;
  bgST: number;
}

interface BrushRange {
  startIndex: number;
  endIndex: number;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

export const MetricsPanel: React.FC<MetricsPanelProps> = ({ payload, loudnessTarget }) => {
  const [activeStreams, setActiveStreams] = useState<Set<string>>(new Set(['diagST', 'bgST']));
  const [flags, setFlags] = useState<{ time: number; label: string }[]>([]);
  const [brushRange, setBrushRange] = useState<BrushRange>({
    startIndex: 0,
    endIndex: Number.MAX_SAFE_INTEGER,
  });

  const graphData = useMemo(() => {
    const lufs = payload.metrics?.lufs_graph;
    if (!lufs) return [];

    const diag = lufs.dialogue_raw;
    const bg = lufs.background_raw;
    if (!diag && !bg) return [];

    const maxLen = Math.max(diag?.momentary.length ?? 0, bg?.momentary.length ?? 0);
    const data: GraphDataPoint[] = [];

    for (let i = 0; i < maxLen; i++) {
      const time = i / 2.0;
      data.push({
        time,
        timeStr: formatTime(time),
        diagM: diag?.momentary[i] ?? -70,
        diagST: diag?.short_term[i] ?? -70,
        bgM: bg?.momentary[i] ?? -70,
        bgST: bg?.short_term[i] ?? -70,
      });
    }
    return data;
  }, [payload.metrics?.lufs_graph]);

  const maxIndex = Math.max(0, graphData.length - 1);
  const effectiveBrushRange = useMemo(() => {
    const start = Math.max(0, Math.min(brushRange.startIndex, maxIndex));
    const rawEnd = brushRange.endIndex === Number.MAX_SAFE_INTEGER ? maxIndex : brushRange.endIndex;
    const end = Math.max(start, Math.min(rawEnd, maxIndex));
    return { startIndex: start, endIndex: end };
  }, [brushRange, maxIndex]);

  const toggleStream = (stream: string) => {
    setActiveStreams((prev) => {
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
      setFlags((prev) => [...prev, { time: point.time, label }]);
    }
  };

  const handleBrushChange = (range: { startIndex?: number; endIndex?: number }) => {
    if (!graphData.length) return;
    const nextStart = Math.max(0, Math.min(range.startIndex ?? 0, graphData.length - 1));
    const nextEnd = Math.max(nextStart, Math.min(range.endIndex ?? graphData.length - 1, graphData.length - 1));
    setBrushRange({ startIndex: nextStart, endIndex: nextEnd });
  };

  const panWindow = (direction: -1 | 1) => {
    if (!graphData.length) return;
    const windowSize = effectiveBrushRange.endIndex - effectiveBrushRange.startIndex + 1;
    const panStep = Math.max(1, Math.floor(windowSize * 0.25));
    let nextStart = effectiveBrushRange.startIndex + direction * panStep;
    nextStart = Math.max(0, Math.min(nextStart, Math.max(0, graphData.length - windowSize)));
    const nextEnd = Math.min(graphData.length - 1, nextStart + windowSize - 1);
    setBrushRange({ startIndex: nextStart, endIndex: nextEnd });
  };

  const resetZoom = () => {
    setBrushRange({ startIndex: 0, endIndex: Number.MAX_SAFE_INTEGER });
  };

  if (!payload.metrics?.lufs_graph) {
    return (
      <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-panel-border bg-background/50">
        <Activity size={48} className="text-text-muted/20 mb-4" />
        <p className="text-text-muted font-medium italic">LUFS graph data not available for this session.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-700">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-2">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-accent/10 text-accent">
            <Activity size={20} />
          </div>
          <div>
            <h3 className="text-[10px] uppercase tracking-widest font-bold text-text-muted leading-tight">Loudness Analysis</h3>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <StreamToggle
            label="DX"
            color="oklch(0.7 0.12 260)"
            isActive={activeStreams.has('diagST')}
            onClick={() => toggleStream('diagST')}
          />
          <StreamToggle
            label="Music"
            color="oklch(0.7 0.12 150)"
            isActive={activeStreams.has('bgST')}
            onClick={() => toggleStream('bgST')}
          />
          <StreamToggle
            label="Momentary"
            color="oklch(0.7 0.12 300)"
            isActive={activeStreams.has('diagM') || activeStreams.has('bgM')}
            onClick={() => {
              toggleStream('diagM');
              toggleStream('bgM');
            }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 text-[10px] font-mono text-text-muted">
        <span>
          Zoom Window: {formatTime(graphData[effectiveBrushRange.startIndex]?.time ?? 0)} - {formatTime(graphData[effectiveBrushRange.endIndex]?.time ?? 0)}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="border border-panel-border px-2 py-1 hover:text-text-main transition-colors"
            onClick={() => panWindow(-1)}
          >
            ◀ Pan
          </button>
          <button
            type="button"
            className="border border-panel-border px-2 py-1 hover:text-text-main transition-colors"
            onClick={() => panWindow(1)}
          >
            Pan ▶
          </button>
          <button
            type="button"
            className="border border-panel-border px-2 py-1 hover:text-text-main transition-colors"
            onClick={resetZoom}
          >
            Reset
          </button>
        </div>
      </div>

      <div className="h-[400px] relative overflow-hidden">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={graphData}
            onClick={handleGraphClick}
            margin={{ top: 20, right: 10, left: -20, bottom: 32 }}
          >
            <defs>
              <linearGradient id="colorDiag" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.7 0.12 260)" stopOpacity={0.15} />
                <stop offset="95%" stopColor="oklch(0.7 0.12 260)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorBg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.7 0.12 150)" stopOpacity={0.15} />
                <stop offset="95%" stopColor="oklch(0.7 0.12 150)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="oklch(0.9 0.01 250)" />
            <XAxis
              dataKey="time"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={formatTime}
              tick={{ fontSize: 9, fill: 'oklch(0.5 0.01 250)', fontWeight: 700 }}
              axisLine={false}
              tickLine={false}
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

            <ReferenceLine y={loudnessTarget.value} stroke="oklch(0.8 0.1 350)" strokeDasharray="3 3">
              <Label
                value={`TARGET (${loudnessTarget.value.toFixed(0)} LUFS)`}
                position="insideTopRight"
                fill="oklch(0.8 0.1 350)"
                fontSize={8}
                fontWeight={900}
              />
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

            <Brush
              dataKey="time"
              height={22}
              stroke="oklch(0.6 0.08 250)"
              tickFormatter={(value) => formatTime(Number(value))}
              startIndex={effectiveBrushRange.startIndex}
              endIndex={effectiveBrushRange.endIndex}
              onChange={handleBrushChange}
              travellerWidth={8}
            />
          </AreaChart>
        </ResponsiveContainer>

        <div className="absolute bottom-10 right-2 flex items-center gap-5 bg-background/90 px-4 py-2 border border-panel-border">
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-widest font-black text-text-muted mb-0.5">Integrated</span>
            <span className="text-xl font-black text-text-main tracking-tighter">
              {typeof payload.metrics?.lufs_graph?.dialogue_raw?.integrated === 'number'
                ? payload.metrics.lufs_graph.dialogue_raw.integrated.toFixed(2)
                : '--'} <span className="text-xs font-medium text-text-muted">LUFS</span>
            </span>
          </div>
          <div className="w-px h-8 bg-panel-border/60" />
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-widest font-black text-text-muted mb-0.5">Peak S.Term</span>
            <span className="text-xl font-black text-text-main tracking-tighter">
              {graphData.length > 0 ? Math.max(...graphData.map((d) => d.diagST)).toFixed(2) : '--'} <span className="text-xs font-medium text-text-muted">LUFS</span>
            </span>
          </div>
        </div>
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
      'px-2.5 py-1 border text-[9px] font-bold uppercase tracking-widest transition-colors flex items-center gap-1.5',
      isActive
        ? 'border-panel-border text-text-main'
        : 'border-transparent text-text-muted opacity-40 hover:opacity-70'
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
      <div className="bg-background border border-panel-border p-3 space-y-2">
        <div className="text-[10px] font-black text-text-muted uppercase tracking-[0.2em] border-b border-panel-border pb-2">{data.timeStr}</div>
        <div className="space-y-2">
          <TooltipRow label="DX" value={data.diagST} color="oklch(0.7 0.12 260)" />
          <TooltipRow label="Music" value={data.bgST} color="oklch(0.7 0.12 150)" />
        </div>
      </div>
    );
  }
  return null;
};

const TooltipRow = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div className="flex items-center justify-between gap-8">
    <div className="flex items-center gap-2.5">
      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{label}</span>
    </div>
    <span className="text-sm font-black text-text-main tracking-tighter">{typeof value === 'number' ? value.toFixed(2) : '0.00'} <span className="text-[9px] font-medium text-text-muted">LUFS</span></span>
  </div>
);

const FlagLabel = ({ label }: { label: string }) => (
  <g transform="translate(0, -10)">
    <rect x="-45" y="-22" width="90" height="22" rx="6" fill="oklch(0.7 0.12 300)" />
    <text x="0" y="-7" textAnchor="middle" fill="white" fontSize="9" fontWeight="900" letterSpacing="0.05em">
      {label.toUpperCase()}
    </text>
  </g>
);
