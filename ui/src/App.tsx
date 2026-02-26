import { useState, useEffect } from 'react';
import { Radio, ArrowLeft, Loader2, CheckCircle2, Circle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { WaveformVisualizer } from './components/WaveformVisualizer';
import { MetricsPanel } from './components/MetricsPanel';
import { DirectorChat } from './components/DirectorChat';
import { LandingHub } from './components/LandingHub';
import { DiagnosticMeters } from './components/DiagnosticMeters';
import { parseMikupPayload, resolveStemAudioSources, type MikupPayload } from './types';
import { clsx } from 'clsx';

type ViewState = 'landing' | 'processing' | 'analysis';

interface ProgressStatus {
  stage: string;
  progress: number;
  message: string;
}

const PIPELINE_STAGES = [
  { id: 'SEPARATION', label: 'Surgical Separation' },
  { id: 'TRANSCRIPTION', label: 'Transcription & Diarization' },
  { id: 'DSP', label: 'Feature Extraction (LUFS)' },
  { id: 'SEMANTICS', label: 'Semantic Understanding' },
  { id: 'AI_DIRECTOR', label: 'AI Director Synthesis' }
];

function App() {
  const [view, setView] = useState<ViewState>('landing');
  const [payload, setPayload] = useState<MikupPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressStatus>({ stage: 'INIT', progress: 0, message: '' });

  useEffect(() => {
    const unlisten = listen<ProgressStatus>('process-status', (event) => {
      setProgress(event.payload);
    });

    return () => {
      unlisten.then(f => f());
    };
  }, []);

  const handleStartNewProcess = async (filePath: string) => {
    setView('processing');
    setError(null);
    setProgress({ stage: 'INIT', progress: 0, message: 'Starting pipeline...' });

    try {
      const result = await invoke<string>('process_audio', { inputPath: filePath });
      const parsed = parseMikupPayload(JSON.parse(result));
      setPayload(parsed);
      setView('analysis');
    } catch (err: any) {
      setError(err.toString());
      setView('landing');
    }
  };

  const handleSelectProject = (projectPayload: MikupPayload) => {
    setPayload(projectPayload);
    setView('analysis');
  };

  if (view === 'landing') {
    return (
      <div className="min-h-screen bg-background selection:bg-accent/10">
        <LandingHub 
          onSelectProject={handleSelectProject} 
          onStartNewProcess={handleStartNewProcess}
          isProcessing={false}
        />
        {error && (
          <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-red-50 border border-red-100 p-4 rounded-2xl flex items-center gap-4 shadow-xl animate-in fade-in slide-in-from-bottom-4">
            <Radio size={20} className="text-red-600 rotate-45" />
            <p className="text-sm font-medium text-red-700">{error}</p>
          </div>
        )}
      </div>
    );
  }

  if (view === 'processing') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-8">
        <div className="max-w-md w-full space-y-12 animate-in fade-in zoom-in-95 duration-500">
          <div className="text-center space-y-2">
            <div className="inline-flex p-4 rounded-3xl bg-accent/10 text-accent mb-4 animate-pulse">
              <Loader2 size={32} className="animate-spin" />
            </div>
            <h2 className="text-3xl font-bold text-text-main tracking-tight">Analyzing Audio</h2>
            <p className="text-text-muted">The Mikup pipeline is deconstructing your mix.</p>
          </div>

          <div className="space-y-6">
            {PIPELINE_STAGES.map((stage, i) => {
              const isDone = PIPELINE_STAGES.findIndex(s => s.id === progress.stage) > i || progress.stage === 'COMPLETE';
              const isCurrent = progress.stage === stage.id;
              
              return (
                <div key={stage.id} className={clsx(
                  "flex items-center gap-4 transition-all duration-500",
                  !isDone && !isCurrent && "opacity-30 grayscale"
                )}>
                  <div className={clsx(
                    "shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-500",
                    isDone ? "bg-accent text-white" : isCurrent ? "bg-accent/20 text-accent ring-2 ring-accent/20" : "bg-panel-border/40 text-text-muted"
                  )}>
                    {isDone ? <CheckCircle2 size={18} /> : isCurrent ? <Loader2 size={16} className="animate-spin" /> : <Circle size={12} fill="currentColor" />}
                  </div>
                  <div className="flex-1">
                    <div className={clsx("text-sm font-bold transition-colors", isCurrent ? "text-text-main" : "text-text-muted")}>
                      {stage.label}
                    </div>
                    {isCurrent && (
                      <div className="text-[10px] font-black uppercase tracking-widest text-accent mt-0.5 animate-in slide-in-from-left-2">
                        {progress.message}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-8">
            <div className="w-full h-1.5 bg-panel-border/30 rounded-full overflow-hidden">
              <div 
                className="h-full bg-accent transition-all duration-700 ease-out"
                style={{ width: `${progress.progress}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
              <span>Progress</span>
              <span>{progress.progress}%</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col p-8 gap-8 bg-background text-text-main selection:bg-accent/10 animate-in fade-in duration-1000">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-6">
          <button 
            onClick={() => setView('landing')}
            className="p-3 rounded-2xl bg-panel border border-panel-border text-text-muted hover:text-accent hover:border-accent/40 transition-all group"
          >
            <ArrowLeft size={20} className="group-hover:-translate-x-1 transition-transform" />
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{payload?.metadata?.source_file.split(/[\\/]/).pop()}</h1>
            <div className="flex items-center gap-2 text-xs text-text-muted mt-0.5">
              <span className="font-bold text-accent uppercase tracking-widest">Analysis Result</span>
              <span>•</span>
              <span>{new Date(payload?.metadata?.timestamp || '').toLocaleString()}</span>
              <span>•</span>
              <span>v{payload?.metadata?.pipeline_version}</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="px-4 py-2 rounded-2xl bg-white border border-panel-border shadow-sm flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-xs font-bold uppercase tracking-widest text-text-main">Pipeline: Success</span>
          </div>
        </div>
      </header>
      
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 min-h-0">
        <div className="lg:col-span-8 flex flex-col gap-8 min-w-0">
          {/* Diagnostic Meters Row */}
          {payload?.metrics?.diagnostic_meters && (
            <DiagnosticMeters metrics={payload.metrics.diagnostic_meters} />
          )}

          {/* Timeline Section */}
          <section className="panel p-8 h-[400px] flex flex-col relative transition-all hover:shadow-2xl hover:shadow-black/[0.03]">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-[10px] font-black text-text-muted uppercase tracking-[0.25em] flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-accent/40" />
                Surgical Timeline
              </h2>
              <div className="text-[10px] text-text-muted font-bold tracking-widest bg-background px-4 py-1.5 rounded-full border border-panel-border">
                {payload?.metrics?.pacing_mikups?.length ?? 0} MIKUPS IDENTIFIED
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <WaveformVisualizer 
                pacing={payload?.metrics?.pacing_mikups} 
                duration={payload?.metrics?.spatial_metrics?.total_duration}
                audioSources={resolveStemAudioSources(payload)}
              />
            </div>
          </section>
          
          {/* LUFS Metrics Section */}
          <section className="panel p-8 flex-1 min-h-[400px] flex flex-col transition-all hover:shadow-2xl hover:shadow-black/[0.03]">
            <MetricsPanel payload={payload!} />
          </section>
        </div>

        {/* Sidebar: AI Director */}
        <aside className="lg:col-span-4 flex flex-col min-w-0">
          <div className="panel p-8 flex-1 flex flex-col min-h-[600px] lg:min-h-0 relative transition-all hover:shadow-2xl hover:shadow-black/[0.03]">
            <h2 className="text-[10px] font-black text-text-muted uppercase tracking-[0.25em] mb-8 flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full bg-accent/40" />
              AI Director Report
            </h2>
            <div className="flex-1 flex flex-col min-h-0">
              <DirectorChat
                key={`${payload?.metadata?.source_file ?? 'none'}:${payload?.ai_report ?? 'none'}`}
                payload={payload}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
