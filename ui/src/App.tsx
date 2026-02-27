import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { WaveformVisualizer } from './components/WaveformVisualizer';
import { MetricsPanel } from './components/MetricsPanel';
import { AIBridge } from './components/AIBridge';
import { LandingHub } from './components/LandingHub';
import { StatsBar } from './components/DiagnosticMeters';
import {
  parseMikupPayload,
  resolveStemAudioSources,
  type MikupPayload,
  type PipelineStageDefinition,
} from './types';
import { clsx } from 'clsx';

type ViewState = 'landing' | 'processing' | 'analysis';

interface ProgressStatus {
  stage: string;
  progress: number;
  message: string;
}

const PIPELINE_STAGES: PipelineStageDefinition[] = [
  { id: 'SEPARATION', label: 'Surgical Separation' },
  { id: 'TRANSCRIPTION', label: 'Transcription & Diarization' },
  { id: 'DSP', label: 'Feature Extraction (LUFS)' },
  { id: 'SEMANTICS', label: 'Semantic Understanding' },
  { id: 'DIRECTOR', label: 'AI Director Synthesis' },
];

function buildProceedPrompt(completedStageLabel: string, nextStage: PipelineStageDefinition): string {
  if (nextStage.id === 'TRANSCRIPTION') {
    return `${completedStageLabel} finished. Proceed to ${nextStage.label} (estimated 3-5 mins)?`;
  }
  return `${completedStageLabel} finished. Proceed to ${nextStage.label}?`;
}

function App() {
  const [view, setView] = useState<ViewState>('landing');
  const [payload, setPayload] = useState<MikupPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressStatus>({ stage: 'INIT', progress: 0, message: '' });
  const [pipelineErrors, setPipelineErrors] = useState<string[]>([]);

  const [inputPath, setInputPath] = useState<string | null>(null);
  const [workspaceDirectory, setWorkspaceDirectory] = useState<string | null>(null);
  const [completedStageCount, setCompletedStageCount] = useState(0);
  const [runningStageIndex, setRunningStageIndex] = useState<number | null>(null);
  const [workflowMessage, setWorkflowMessage] = useState('Select an audio file to begin.');
  const [fastMode, setFastMode] = useState(false);
  const [isPreparingWorkflow, setIsPreparingWorkflow] = useState(false);

  useEffect(() => {
    const unlisten = listen<ProgressStatus>('process-status', (event) => {
      setProgress(event.payload);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>('process-error', (event) => {
      setPipelineErrors((prev) => [...prev, event.payload]);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const handleStartNewProcess = async (filePath: string) => {
    if (!filePath.trim()) {
      setError('Selected audio file path is invalid.');
      return;
    }

    setIsPreparingWorkflow(true);
    setError(null);
    setPipelineErrors([]);

    try {
      const selectedDirectory = await open({
        multiple: false,
        directory: true,
        title: 'Choose output workspace folder',
      });

      if (typeof selectedDirectory !== 'string') {
        setError('No output folder selected. Choose a folder to continue.');
        return;
      }

      setInputPath(filePath);
      setWorkspaceDirectory(selectedDirectory);
      setRunningStageIndex(null);

      let resumeCount = 0;
      try {
        resumeCount = await invoke<number>('get_pipeline_state', {
          outputDirectory: selectedDirectory,
        });
      } catch {
        // non-fatal: treat as fresh start
        resumeCount = 0;
      }

      setCompletedStageCount(resumeCount);

      if (resumeCount > 0 && resumeCount < PIPELINE_STAGES.length) {
        const nextStage = PIPELINE_STAGES[resumeCount];
        setWorkflowMessage(
          `Previous progress found. Resuming from Stage ${resumeCount + 1}: ${nextStage.label}.`
        );
        setProgress({ stage: 'INIT', progress: 0, message: `Resuming from stage ${resumeCount + 1}.` });
      } else if (resumeCount >= PIPELINE_STAGES.length) {
        try {
          const result = await invoke<string>('read_output_payload', {
            outputDirectory: selectedDirectory,
          });
          const parsed = parseMikupPayload(JSON.parse(result));
          setPayload(parsed);
          setView('analysis');
          return;
        } catch {
          // payload not readable yet — fall through to processing view
          setWorkflowMessage('All stages previously completed. Re-run any stage or load results.');
          setProgress({ stage: 'COMPLETE', progress: 100, message: 'Previously completed.' });
        }
      } else {
        setWorkflowMessage('Workspace selected. Run Stage 1: Surgical Separation.');
        setProgress({ stage: 'INIT', progress: 0, message: 'Ready to run stage 1.' });
      }

      setView('processing');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPreparingWorkflow(false);
    }
  };

  const runStage = async (stageIndex: number, force = false): Promise<void> => {
    if (!inputPath || !workspaceDirectory) {
      setError('Input file and workspace folder are required before running stages.');
      return;
    }

    if (
      runningStageIndex !== null ||
      stageIndex < 0 ||
      stageIndex >= PIPELINE_STAGES.length
    ) {
      return;
    }

    const stage = PIPELINE_STAGES[stageIndex];

    setError(null);
    setPipelineErrors([]);
    setRunningStageIndex(stageIndex);
    setProgress({ stage: stage.id, progress: 0, message: `Running ${stage.label}...` });

    try {
      await invoke<string>('run_pipeline_stage', {
        inputPath,
        outputDirectory: workspaceDirectory,
        stage: stage.id,
        fastMode,
        force,
      });

      const nextCompletedCount = Math.max(completedStageCount, stageIndex + 1);
      setCompletedStageCount(nextCompletedCount);
      setRunningStageIndex(null);

      if (nextCompletedCount >= PIPELINE_STAGES.length) {
        setWorkflowMessage('All stages complete. Loading analysis payload...');
        const result = await invoke<string>('read_output_payload', {
          outputDirectory: workspaceDirectory,
        });
        const parsed = parseMikupPayload(JSON.parse(result));
        setPayload(parsed);
        setView('analysis');
        return;
      }

      const nextStage = PIPELINE_STAGES[nextCompletedCount];
      const promptMessage = buildProceedPrompt(stage.label, nextStage);
      setWorkflowMessage(promptMessage);

      const shouldProceed = window.confirm(promptMessage);
      if (shouldProceed) {
        await runStage(nextCompletedCount);
      }
    } catch (err: unknown) {
      setRunningStageIndex(null);
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setWorkflowMessage(`Stage failed. Resolve the error and retry ${stage.label}.`);
    }
  };

  const handleRunNextStage = async () => {
    await runStage(completedStageCount);
  };

  const handleRerunStage = async (stageIndex: number) => {
    await runStage(stageIndex, true);
  };

  const handleSelectProject = (projectPayload: MikupPayload) => {
    setError(null);
    setPayload(projectPayload);
    setView('analysis');
  };

  if (view === 'landing') {
    return (
      <div className="min-h-screen bg-background">
        <LandingHub
          onSelectProject={handleSelectProject}
          onStartNewProcess={handleStartNewProcess}
          isProcessing={isPreparingWorkflow}
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
    const nextStage = PIPELINE_STAGES[completedStageCount];

    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-8">
        <div className="max-w-xl w-full space-y-8 animate-in fade-in duration-500">
          <div>
            <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-1">Manual Workflow</p>
            <h2 className="text-2xl font-semibold text-text-main">Run pipeline stage-by-stage</h2>
          </div>

          <div className="space-y-2 text-[11px] font-mono text-text-muted border border-panel-border p-4">
            <p className="truncate">Input: {inputPath ?? 'None selected'}</p>
            <p className="truncate">Workspace: {workspaceDirectory ?? 'None selected'}</p>
          </div>

          <label className="flex items-center gap-3 text-sm text-text-main select-none">
            <input
              type="checkbox"
              checked={fastMode}
              onChange={(e) => setFastMode(e.target.checked)}
              disabled={runningStageIndex !== null}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Fast Mode
          </label>

          <div className="space-y-3">
            {PIPELINE_STAGES.map((stage, i) => {
              const isComplete = i < completedStageCount;
              const isRunning = i === runningStageIndex;
              const isReady = i === completedStageCount && runningStageIndex === null;

              return (
                <div
                  key={stage.id}
                  className={clsx(
                    'flex items-center gap-3 transition-opacity duration-300',
                    !isComplete && !isRunning && !isReady && 'opacity-35'
                  )}
                >
                  <div
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      backgroundColor:
                        isComplete || isRunning || isReady
                          ? 'var(--color-accent)'
                          : 'var(--color-panel-border)',
                    }}
                  />
                  <span className={clsx('text-sm transition-colors', (isRunning || isReady) ? 'text-text-main font-medium' : 'text-text-muted')}>
                    {stage.label}
                  </span>
                  {isComplete ? (
                    <button
                      type="button"
                      onClick={() => handleRerunStage(i)}
                      disabled={runningStageIndex !== null}
                      className="ml-auto text-[10px] font-mono text-text-muted hover:text-accent transition-colors disabled:opacity-40"
                      title={`Re-run ${stage.label}`}
                    >
                      Re-run
                    </button>
                  ) : (
                    <span className="ml-auto text-[10px] font-mono text-text-muted">
                      {isRunning ? 'Running' : isReady ? 'Ready' : 'Locked'}
                    </span>
                  )}
                  {isRunning && <Loader2 size={12} className="animate-spin text-accent" />}
                </div>
              );
            })}
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={handleRunNextStage}
              disabled={runningStageIndex !== null || !nextStage}
              className={clsx(
                'w-full border px-4 py-3 text-sm font-medium transition-colors',
                runningStageIndex !== null || !nextStage
                  ? 'border-panel-border text-text-muted cursor-not-allowed'
                  : 'border-accent text-accent hover:bg-accent/5'
              )}
            >
              {runningStageIndex !== null
                ? `Running ${PIPELINE_STAGES[runningStageIndex].label}...`
                : nextStage
                  ? `Run ${nextStage.label}`
                  : 'All stages complete'}
            </button>
            <p className="text-[11px] text-text-muted">{workflowMessage}</p>
          </div>

          <div>
            <div className="w-full h-px bg-panel-border relative">
              <div
                className="absolute top-0 left-0 h-px bg-accent transition-all duration-700 ease-out"
                style={{ width: `${Math.min(100, Math.max(0, progress.progress))}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 text-[10px] font-mono text-text-muted">
              <span>{progress.message || 'Waiting for stage run...'}</span>
              <span>{Math.min(100, Math.max(0, progress.progress))}%</span>
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
        <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Analysis Result</span>
      </header>

      <div className="px-6 py-4">
        {payload?.metrics?.diagnostic_meters && (
          <StatsBar
            metrics={payload.metrics.diagnostic_meters}
            gapCount={payload?.metrics?.pacing_mikups?.length ?? 0}
            integratedLufs={payload?.metrics?.lufs_graph?.dialogue_raw?.integrated ?? null}
          />
        )}
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0">
        <div className="lg:col-span-8 flex flex-col border-r border-panel-border">
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
                outputDir={payload?.artifacts?.output_dir}
              />
            </div>
          </section>

          <section className="flex-1 px-6 py-5 min-h-[360px]">
            <MetricsPanel payload={payload!} />
          </section>
        </div>

        <aside className="lg:col-span-4 flex flex-col px-6 py-5">
          <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-4">
            AI Bridge
          </span>
          <div className="flex-1 flex flex-col min-h-0">
            <AIBridge
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
