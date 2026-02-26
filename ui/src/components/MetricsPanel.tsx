import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, CartesianGrid } from 'recharts';

export function MetricsPanel({ metrics, semantics }: { metrics: any, semantics: any }) {
  const pacingData = metrics?.pacing_mikups?.map((m: any, i: number) => ({
    name: `Gap ${i+1}`,
    duration: m.duration_ms,
  })) || [];

  // Mocking a loudness curve for visualization since the payload doesn't have the raw curve yet
  const loudnessData = Array.from({ length: 40 }, (_, i) => ({
    time: i,
    dialogue: 50 + Math.sin(i * 0.5) * 20 + (Math.random() * 10),
    music: 30 + Math.cos(i * 0.5) * 10 + (Math.random() * 5),
  }));

  const tags = semantics?.background_tags || [];

  return (
    <div className="flex flex-col h-full gap-8">
      {/* Top Row: Loudness Curve */}
      <div className="h-48">
        <h3 className="text-xs text-textMuted mb-4 uppercase tracking-widest">Loudness & Ducking Curve (LUFS Proxy)</h3>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={loudnessData}>
            <defs>
              <linearGradient id="colorDiag" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#5a5ae6" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#5a5ae6" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <Tooltip 
              contentStyle={{ backgroundColor: '#151517', border: '1px solid rgba(255,255,255,0.1)' }}
            />
            <Area type="monotone" dataKey="dialogue" stroke="#5a5ae6" fillOpacity={1} fill="url(#colorDiag)" strokeWidth={2} />
            <Area type="monotone" dataKey="music" stroke="#8b8b8f" fill="transparent" strokeDasharray="5 5" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Bottom Row: Pacing and Semantics */}
      <div className="grid grid-cols-2 gap-8 flex-1">
        <div className="flex flex-col">
          <h3 className="text-xs text-textMuted mb-2 uppercase tracking-widest">Pacing Gaps (ms)</h3>
          <div className="flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pacingData}>
                <XAxis dataKey="name" hide />
                <Bar dataKey="duration" fill="#5a5ae6" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="flex flex-col">
          <h3 className="text-xs text-textMuted mb-2 uppercase tracking-widest">Semantic Tags</h3>
          <div className="space-y-4 mt-2">
            {tags.map((tag: any, i: number) => (
              <div key={i} className="space-y-1">
                <div className="flex justify-between text-[10px]">
                  <span className="font-bold">{tag.label.toUpperCase()}</span>
                  <span className="text-accent">{(tag.score * 100).toFixed(0)}%</span>
                </div>
                <div className="w-full bg-white/5 h-1 rounded-full">
                  <div className="bg-accent h-full" style={{ width: `${tag.score * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
