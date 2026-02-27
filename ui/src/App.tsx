import { useState, useEffect } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { WaveformVisualizer } from './components/WaveformVisualizer';
import { MetricsPanel } from './components/MetricsPanel';
import { DirectorChat } from './components/DirectorChat';
import { LandingHub } from './components/LandingHub';
import { StatsBar } from './components/DiagnosticMeters';
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
  const [pipelineErrors, setPipelineErrors] = useState<string[]>([]);

  useEffect(() => {
    const unlisten = listen<ProgressStatus>('process-status', (event) => {
      setProgress(event.payload);
    });

    return () => {
      unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>('process-error', (event) => {
      setPipelineErrors(prev => [...prev, event.payload]);
    });

    return () => {
      unlisten.then(f => f());
    };
  }, []);

  const handleStartNewProcess = async (filePath: string) => {
    setView('processing');
    setError(null);
    setPipelineErrors([]);
    setProgress({ stage: 'INIT', progress: 0, message: 'Starting pipeline...' });

    try {
      const result = await invoke<string>('process_audio', { inputPath: filePath });
      const parsed = parseMikupPayload(JSON.parse(result));
      setPayload(parsed);
      setView('analysis');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setView('landing');
    }
  };

  const handleSelectProject = (projectPayload: MikupPayload) => {
    setPayload(projectPayload);
    setView('analysis');
  };

  if (view === 'landing') {
    return (
      <div className="min-h-screen bg-background">
        <LandingHub
          onSelectProject={handleSelectProject}
          onStartNewProcess={handleStartNewProcess}
          isProcessing={false}
        />
        {error && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }

  if (view === 'processing') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-8">
        <div className="max-w-sm w-full space-y-8 animate-in fade-in duration-500">
          <div>
            <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-1">Processing</p>
            <h2 className="text-2xl font-semibold text-text-main">Analyzing audio</h2>
          </div>

          <div className="space-y-3">
            {PIPELINE_STAGES.map((stage, i) => {
              const stageIndex = PIPELINE_STAGES.findIndex(s => s.id === progress.stage);
              const isDone = stageIndex > i || progress.stage === 'COMPLETE';
              const isCurrent = progress.stage === stage.id;

              return (
                <div key={stage.id} className={clsx(
                  "flex items-center gap-3 transition-opacity duration-300",
                  !isDone && !isCurrent && "opacity-30"
                )}>
                  <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{
                    backgroundColor: isDone || isCurrent ? 'var(--color-accent)' : 'var(--color-panel-border)'
                  }} />
                  <span className={clsx(
                    "text-sm transition-colors",
                    isCurrent ? "text-text-main font-medium" : "text-text-muted"
                  )}>
                    {stage.label}
                  </span>
                  {isCurrent && (
                    <Loader2 size={12} className="animate-spin text-accent ml-auto" />
                  )}
                </div>
              );
            })}
          </div>

          <div>
            <div className="w-full h-px bg-panel-border relative">
              <div
                className="absolute top-0 left-0 h-px bg-accent transition-all duration-700 ease-out"
                style={{ width: `${progress.progress}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 text-[10px] font-mono text-text-muted">
              <span>Progress</span>
              <span>{progress.progress}%</span>
            </div>
          </div>

          {pipelineErrors.length > 0 && (
            <div className="max-h-28 overflow-y-auto space-y-1 border-t border-panel-border pt-3">
              {pipelineErrors.map((msg, i) => (
                <p key={i} className="text-[10px] font-mono text-red-500">{msg}</p>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-text-main animate-in fade-in duration-500">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-panel-border">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setView('landing')}
            className="text-text-muted hover:text-accent transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <span className="text-sm font-mono font-medium text-text-main">
              {payload?.metadata?.source_file.split(/[\\/]/).pop()}
            </span>
            <span className="text-[11px] font-mono text-text-muted ml-4">
              {new Date(payload?.metadata?.timestamp || '').toLocaleDateString()}
              &nbsp;·&nbsp;
              v{payload?.metadata?.pipeline_version}
            </span>
          </div>
        </div>
        <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">
          Analysis Result
        </span>
      </header>

      {/* Stats Bar */}
      <div className="px-6 py-4">
        {payload?.metrics?.diagnostic_meters && (
          <StatsBar
            metrics={payload.metrics.diagnostic_meters}
            gapCount={payload?.metrics?.pacing_mikups?.length ?? 0}
            integratedLufs={payload?.metrics?.lufs_graph?.dialogue_raw?.integrated ?? null}
          />
        )}
      </div>

      {/* Main grid */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0">
        {/* Left column */}
        <div className="lg:col-span-8 flex flex-col border-r border-panel-border">
          {/* Timeline */}
          <section className="flex flex-col px-6 py-5 border-b border-panel-border" style={{ height: '360px' }}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Timeline</span>
              <span className="text-[10px] font-mono text-text-muted">
                {payload?.metrics?.pacing_mikups?.length ?? 0} gaps detected
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <WaveformVisualizer
                pacing={payload?.metrics?.pacing_mikups}
                duration={payload?.metrics?.spatial_metrics?.total_duration}
                audioSources={resolveStemAudioSources(payload)}
              />
            </div>
          </section>

          {/* Loudness Analysis */}
          <section className="flex-1 px-6 py-5 min-h-[360px]">
            <MetricsPanel payload={payload!} />
          </section>
        </div>

        {/* Right column — Analysis Report */}
        <aside className="lg:col-span-4 flex flex-col px-6 py-5">
          <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-4">
            Analysis Report
          </span>
          <div className="flex-1 flex flex-col min-h-0">
            <DirectorChat
              key={`${payload?.metadata?.source_file ?? 'none'}:${payload?.ai_report ?? 'none'}`}
              payload={payload}
            />
          </div>
        </aside>
      </div>

      {error && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}

export default App;
