import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, AreaChart, Area, YAxis } from 'recharts';
import type { MikupPayload } from '../types';

export function MetricsPanel({ metrics, semantics }: { metrics?: MikupPayload['metrics'], semantics?: MikupPayload['semantics'] }) {
  const pacingData = metrics?.pacing_mikups?.map((m, i) => ({
    name: `Gap ${i+1}`,
    duration: m.duration_ms,
  })) || [];

  // Mocking a loudness curve for visualization
  const loudnessData = Array.from({ length: 60 }, (_, i) => ({
    time: i,
    dialogue: 45 + Math.sin(i * 0.4) * 15 + Math.random() * 5,
    music: 20 + Math.cos(i * 0.3) * 8 + Math.random() * 3,
  }));

  const tags = semantics?.background_tags || [];

  return (
    <div className="flex flex-col h-full gap-12">
      {/* Top Row: Loudness Curve */}
      <div className="flex-1 min-h-[200px]">
        <div className="flex items-center justify-between mb-8">
          <h3 className="text-xs text-textMuted uppercase tracking-widest font-bold">Loudness Density</h3>
          <div className="flex gap-6">
            <LegendItem color="var(--color-accent)" label="Dialogue" />
            <LegendItem color="oklch(0.92 0.04 250)" label="Background" />
          </div>
        </div>
        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={loudnessData}>
              <defs>
                <linearGradient id="colorDiag" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-accent)" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="var(--color-accent)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <Tooltip 
                contentStyle={{ backgroundColor: 'white', border: '1px solid var(--color-panel-border)', borderRadius: '12px', fontSize: '11px', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.05)' }}
                itemStyle={{ color: 'var(--color-text-main)' }}
              />
              <Area 
                type="monotone" 
                dataKey="dialogue" 
                stroke="var(--color-accent)" 
                fillOpacity={1} 
                fill="url(#colorDiag)" 
                strokeWidth={2.5} 
                animationDuration={1000}
              />
              <Area 
                type="monotone" 
                dataKey="music" 
                stroke="oklch(0.9 0.02 250)" 
                fill="oklch(0.96 0.01 250)" 
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Bottom Row: Pacing and Semantics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
        <div className="flex flex-col">
          <h3 className="text-xs text-textMuted mb-6 uppercase tracking-widest font-bold">Temporal Gaps</h3>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pacingData}>
                <XAxis dataKey="name" hide />
                <YAxis hide domain={[0, 'auto']} />
                <Tooltip 
                  cursor={{ fill: 'var(--color-accent-dim)' }}
                  contentStyle={{ backgroundColor: 'white', border: '1px solid var(--color-panel-border)', borderRadius: '10px', fontSize: '10px' }}
                />
                <Bar 
                  dataKey="duration" 
                  fill="var(--color-accent)" 
                  radius={[4, 4, 4, 4]} 
                  opacity={0.3}
                  className="hover:opacity-100 transition-all duration-300"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="flex flex-col">
          <h3 className="text-xs text-textMuted mb-6 uppercase tracking-widest font-bold">Semantic Vectors</h3>
          <div className="grid gap-5">
            {tags.length > 0 ? tags.slice(0, 4).map((tag, i) => (
              <div key={i} className="group cursor-default">
                <div className="flex justify-between text-[11px] mb-2 font-medium">
                  <span className="text-textMain/70 group-hover:text-accent transition-colors">{tag.label ? tag.label.toUpperCase() : 'UNKNOWN'}</span>
                  <span className="text-textMuted">{Math.round((tag.score || 0) * 100)}%</span>
                </div>
                <div className="w-full bg-background h-2 rounded-full overflow-hidden border border-panel-border">
                  <div 
                    className="bg-accent h-full transition-all duration-1000 ease-out opacity-40 group-hover:opacity-100" 
                    style={{ width: `${Math.min(Math.max((tag.score || 0) * 100, 0), 100)}%` }} 
                  />
                </div>
              </div>
            )) : (
              <div className="flex items-center justify-center h-24 border-2 border-dashed border-panel-border rounded-2xl bg-background/50">
                <p className="text-xs text-textMuted font-medium italic">Waiting for analysis...</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div 
        className="w-3 h-0.5" 
        style={{ 
          backgroundColor: color, 
          borderTop: dashed ? `1px dashed ${color}` : 'none',
          height: dashed ? 0 : '2px'
        }} 
      />
      <span className="text-[9px] text-textMuted font-bold uppercase tracking-tighter">{label}</span>
    </div>
  );
}
