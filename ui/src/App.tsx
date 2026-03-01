import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { WaveformVisualizer } from './components/WaveformVisualizer';
import { MetricsPanel } from './components/MetricsPanel';
import { AIBridge } from './components/AIBridge';
import { TranscriptScrubber } from './components/TranscriptScrubber';
import { LandingHub } from './components/LandingHub';
import { MikupConsole } from './components/MikupConsole';
import { StatsBar, LiveMeters } from './components/DiagnosticMeters';
import { Vectorscope } from './components/Vectorscope';
import { StemControlStrip } from './components/StemControlStrip';
import { useDspStream } from './hooks/useDspStream';
import {
  parseMikupPayload,
  resolveStemAudioSources,
  type MikupPayload,
  type PipelineStageDefinition,
  type LufsSeries,
  type AppConfig,
  type WorkspaceSetupResult,
} from './types';
import { clsx } from 'clsx';

type ViewState = 'landing' | 'processing' | 'analysis';
type LoudnessTargetId = 'streaming' | 'broadcast';

interface ProgressStatus {
  stage: string;
  progress: number;
  message: string;
}

const LOUDNESS_TARGETS: Record<LoudnessTargetId, { label: string; value: number }> = {
  streaming: { label: 'Streaming (-14 LUFS)', value: -14 },
  broadcast: { label: 'Broadcast (-23 LUFS)', value: -23 },
};

const PIPELINE_STAGES: PipelineStageDefinition[] = [
  { id: 'SEPARATION', label: 'Surgical Separation' },
  { id: 'TRANSCRIPTION', label: 'Transcription & Diarization' },
  { id: 'DSP', label: 'Feature Extraction (LUFS)' },
  { id: 'SEMANTICS', label: 'Semantic Tagging' },
  { id: 'DIRECTOR', label: 'AI Director Synthesis' },
];

const DSP_STAGE_INDEX = PIPELINE_STAGES.findIndex((s) => s.id === 'DSP');

function resolvePlaybackStemPaths(
  payload: MikupPayload | null,
  inputPath: string | null,
  workspaceDirectory: string | null,
): [string, string, string] {
  const stems = payload?.artifacts?.stem_paths ?? [];

  // Prefer canonical stem names from the payload artifacts.
  const payloadDX = stems.find((p) => /_DX\./i.test(p));
  const payloadMusic = stems.find((p) => /_Music\./i.test(p));
  const payloadEffects = stems.find((p) => /_Effects\./i.test(p));

  if (payloadDX && payloadMusic && payloadEffects) {
    return [payloadDX, payloadMusic, payloadEffects];
  }

  // Fallback: derive paths from workspace + input filename.
  if (inputPath && workspaceDirectory) {
    const filename = inputPath.replace(/^.*[\\/]/, '');
    const baseName = filename.replace(/\.[^/.]+$/, '');
    return [
      `${workspaceDirectory}/stems/${baseName}_DX.wav`,
      `${workspaceDirectory}/stems/${baseName}_Music.wav`,
      `${workspaceDirectory}/stems/${baseName}_Effects.wav`,
    ];
  }

  return [stems[0] ?? '', stems[1] ?? '', stems[2] ?? ''];
}

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
  const [loudnessTargetId, setLoudnessTargetId] = useState<LoudnessTargetId>('streaming');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [showFirstRunModal, setShowFirstRunModal] = useState(false);
  const [highlightAtSecs, setHighlightAtSecs] = useState<number | null>(null);

  const loudnessTarget = LOUDNESS_TARGETS[loudnessTargetId];

  const dspStream = useDspStream();
  const { startStream: startDspStream, stopStream: stopDspStream } = dspStream;

  const ghostStemPaths = useMemo(() => {
    const [, musicPath, effectsPath] = resolvePlaybackStemPaths(payload, inputPath, workspaceDirectory);
    return {
      musicPath: musicPath || undefined,
      effectsPath: effectsPath || undefined,
    };
  }, [payload, inputPath, workspaceDirectory]);

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

  // Seek the audio player when the AI Director calls seek_audio.
  useEffect(() => {
    const unlisten = listen<{ tool: string; time_secs?: number }>('agent-action', (event) => {
      if (event.payload.tool === 'seek_audio' && typeof event.payload.time_secs === 'number') {
        const [dxPath, musicPath, effectsPath] = resolvePlaybackStemPaths(
          payload,
          inputPath,
          workspaceDirectory,
        );
        if (dxPath) {
          dspStream.startStream(dxPath, musicPath, effectsPath, event.payload.time_secs);
        }
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [payload, inputPath, workspaceDirectory, startDspStream]);

  // Load app config on mount; gate on first-run modal if no default projects dir is set.
  useEffect(() => {
    invoke<AppConfig>('get_app_config')
      .then((cfg) => {
        if (!cfg.default_projects_dir) {
          setShowFirstRunModal(true);
        } else {
          setConfig(cfg);
        }
      })
      .catch(() => {
        // Config unreadable — show first-run modal as safe fallback.
        setShowFirstRunModal(true);
      });
  }, []);

  const handleFirstRunSave = async () => {
    setError(null);
    const selectedDir = await open({
      multiple: false,
      directory: true,
      title: 'Choose your default Mikup projects folder',
    });
    if (typeof selectedDir !== 'string') return;

    try {
      const saved = await invoke<AppConfig>('set_default_projects_dir', { path: selectedDir });
      setConfig(saved);
      setShowFirstRunModal(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleChangeDefaultFolder = async () => {
    const selectedDir = await open({
      multiple: false,
      directory: true,
      title: 'Change default Mikup projects folder',
    });
    if (typeof selectedDir !== 'string') return;

    try {
      const saved = await invoke<AppConfig>('set_default_projects_dir', { path: selectedDir });
      setConfig(saved);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStartNewProcess = async (filePath: string, overrideDir?: string) => {
    if (!filePath.trim()) {
      setError('Selected audio file path is invalid.');
      return;
    }
    if (!config) {
      setError('App config not loaded. Restart the application.');
      return;
    }

    const baseDir = overrideDir ?? config.default_projects_dir;

    setIsPreparingWorkflow(true);

    try {
      setError(null);
      setPipelineErrors([]);
      const workspace = await invoke<WorkspaceSetupResult>('setup_project_workspace', {
        inputPath: filePath,
        baseDirectory: baseDir,
      });

      setInputPath(workspace.copied_input_path);
      setWorkspaceDirectory(workspace.workspace_dir);
      setRunningStageIndex(null);

      let resumeCount = 0;
      try {
        resumeCount = await invoke<number>('get_pipeline_state', {
          outputDirectory: workspace.workspace_dir,
        });
      } catch {
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
            outputDirectory: workspace.workspace_dir,
          });
          const parsed = parseMikupPayload(JSON.parse(result));
          setPayload(parsed);
          setView('analysis');
          return;
        } catch {
          setWorkflowMessage('All stages previously completed. Re-run any stage or load results.');
          setProgress({ stage: 'COMPLETE', progress: 100, message: 'Previously completed.' });
        }
      } else {
        setWorkflowMessage('Workspace ready. Run Stage 1: Surgical Separation.');
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

    // DSP is handled entirely by the Rust Turbo Scan — no Python invocation, no live stream.
    if (stageIndex === DSP_STAGE_INDEX) {
      if (!inputPath || !workspaceDirectory) return;

      try {
        const stems = await invoke<Record<string, string | null>>('get_stems', { outputDirectory: workspaceDirectory });

        // Use canonical 3-stem keys from the backend
        const stemPaths: Record<string, string> = {
          DX: stems['DX'] ?? stems['dx_raw'] ?? stems['dialogue_raw'] ?? '',
          Music: stems['Music'] ?? stems['music_raw'] ?? stems['background_raw'] ?? '',
          Effects: stems['Effects'] ?? stems['effects_raw'] ?? '',
        };

        // Critical check: We at least need DX and Music to perform a meaningful scan
        if (!stemPaths.DX || !stemPaths.Music) {
          throw new Error("Core stems (DX or Music) not found. Stage 1 may have failed.");
        }

        setProgress({ stage: 'DSP', progress: 0, message: 'Starting Turbo Scan...' });
        const scanResult = await invoke<{ lufs_graph: Record<string, LufsSeries> }>('generate_static_map', {
          outputDirectory: workspaceDirectory,
          stemPaths,
        });

        // Persist stage state so get_pipeline_state returns 3 on resume.
        await invoke<void>('mark_dsp_complete', { outputDirectory: workspaceDirectory }).catch(() => {});

        const nextCount = Math.max(completedStageCount, DSP_STAGE_INDEX + 1);
        setCompletedStageCount(nextCount);
        setRunningStageIndex(null);

        // Read the payload persisted by Python stages, merge in the Turbo Scan LUFS graph.
        try {
          const result = await invoke<string>('read_output_payload', { outputDirectory: workspaceDirectory });
          const parsed = parseMikupPayload(JSON.parse(result));

          const mergedMetrics = {
            pacing_mikups: parsed.metrics?.pacing_mikups ?? [],
            spatial_metrics: parsed.metrics?.spatial_metrics ?? { total_duration: 0 },
            impact_metrics: parsed.metrics?.impact_metrics ?? {},
            lufs_graph: scanResult.lufs_graph,
            diagnostic_meters: parsed.metrics?.diagnostic_meters,
            diagnostic_events: parsed.metrics?.diagnostic_events,
          };

          setPayload({
            ...parsed,
            metrics: mergedMetrics,
          });
        } catch {
          // Payload not yet on disk — merge scan results into memory or build a minimal payload.
          setPayload((prev) => {
            if (prev) {
              return {
                ...prev,
                metrics: {
                  pacing_mikups: prev.metrics?.pacing_mikups ?? [],
                  spatial_metrics: prev.metrics?.spatial_metrics ?? { total_duration: 0 },
                  impact_metrics: prev.metrics?.impact_metrics ?? {},
                  ...prev.metrics,
                  lufs_graph: scanResult.lufs_graph,
                },
              };
            }
            // No prior payload on disk or in memory — build a minimal one from Turbo Scan.
            return {
              metadata: {
                source_file: inputPath ?? '',
                pipeline_version: '0.2.0-beta',
              },
              metrics: {
                pacing_mikups: [],
                spatial_metrics: { total_duration: 0 },
                impact_metrics: {},
                lufs_graph: scanResult.lufs_graph,
              },
              is_complete: false,
            };
          });
        }

        if (nextCount >= PIPELINE_STAGES.length) {
          setWorkflowMessage('All stages complete. Loading analysis...');
          setView('analysis');
        } else {
          const nextStage = PIPELINE_STAGES[nextCount];
          setWorkflowMessage(`DSP complete. Proceed to ${nextStage.label} to continue.`);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        setRunningStageIndex(null);
        setWorkflowMessage('DSP Turbo Scan failed. Check that Stage 1 stems exist and retry.');
      }
      return;
    }

    try {
      await invoke<string>('run_pipeline_stage', {
        inputPath,
        outputDirectory: workspaceDirectory,
        stage: stage.id,
        fastMode,
        force,
      });

      const nextCompletedCount = force
        ? stageIndex + 1
        : Math.max(completedStageCount, stageIndex + 1);
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
    // Restore workspace context so resolvePlaybackStemPaths can resolve relative stem paths.
    setWorkspaceDirectory(projectPayload.artifacts?.output_dir ?? null);
    setInputPath(projectPayload.metadata?.source_file ?? null);
    setView('analysis');
  };

  // Show nothing until config is resolved to avoid a flash of landing page.
  if (!config && !showFirstRunModal) {
    return null;
  }

  if (showFirstRunModal) {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center z-50">
        <div className="border border-panel-border p-8 max-w-md w-full mx-4 space-y-6 animate-in fade-in duration-300">
          <div>
            <p className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-2">
              Initial Setup
            </p>
            <h2 className="text-xl font-semibold text-text-main">Welcome to Mikup</h2>
          </div>
          <p className="text-sm text-text-muted font-mono leading-relaxed">
            Choose a folder where Mikup will create project workspaces. Each audio file you
            analyse will get its own timestamped subfolder inside this directory.
          </p>
          {error && (
            <p className="text-[11px] font-mono text-red-400">{error}</p>
          )}
          <button
            type="button"
            onClick={handleFirstRunSave}
            className="w-full border border-accent text-accent px-4 py-3 text-sm font-medium hover:bg-accent/5 transition-colors"
          >
            Choose Folder…
          </button>
        </div>
      </div>
    );
  }

  if (view === 'landing') {
    return (
      <div className="min-h-screen bg-background">
        <LandingHub
          onSelectProject={handleSelectProject}
          onStartNewProcess={handleStartNewProcess}
          isProcessing={isPreparingWorkflow}
          config={config}
          onChangeDefaultFolder={handleChangeDefaultFolder}
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
              {/* Stage progress dots */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {PIPELINE_STAGES.map((stage, i) => {
                  const isComplete = i < completedStageCount;
                  const isRunning = i === runningStageIndex;
                  const isReady = i === completedStageCount && runningStageIndex === null;
                  return (
                    <div key={stage.id} className="flex items-center gap-1.5">
                      <div
                        className="w-1.5 h-1.5 rounded-full"
                        style={{
                          backgroundColor:
                            isComplete || isRunning || isReady
                              ? 'var(--color-accent)'
                              : 'var(--color-panel-border)',
                        }}
                      />
                      <span className={`text-[10px] font-mono ${isRunning || isReady ? 'text-text-main' : 'text-text-muted opacity-50'}`}>
                        {stage.label}
                      </span>
                      {isComplete && (
                        <button
                          type="button"
                          onClick={() => handleRerunStage(i)}
                          disabled={runningStageIndex !== null}
                          className="text-[9px] font-mono text-text-muted hover:text-accent transition-colors disabled:opacity-40 ml-1"
                        >
                          re-run
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Cinematic console */}
              <div className="h-52 border border-panel-border overflow-hidden rounded">
                <MikupConsole />
              </div>
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
              {(() => {
                const ts = payload?.metadata?.timestamp;
                if (!ts) return '—';
                const d = new Date(ts);
                return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
              })()}
              &nbsp;·&nbsp;
              v{payload?.metadata?.pipeline_version || '0.2.0-beta'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <StemControlStrip />
          {payload?.is_complete === false && (
            <span className="text-[9px] uppercase tracking-widest font-bold text-amber-500 border border-amber-500/40 px-2 py-0.5">
              Partial Result
            </span>
          )}
          <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Analysis Result</span>
        </div>
      </header>

      <div className="px-6 py-4">
        {payload?.metrics?.diagnostic_meters && (
          <StatsBar
            metrics={payload.metrics.diagnostic_meters}
            eventCount={payload?.metrics?.pacing_mikups?.length ?? 0}
            integratedLufs={payload?.metrics?.lufs_graph?.DX?.integrated ?? payload?.metrics?.lufs_graph?.dialogue_raw?.integrated ?? null}
          />
        )}
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0">
        <div className="lg:col-span-8 flex flex-col border-r border-panel-border">
          <section className="flex flex-col px-6 py-5 border-b border-panel-border" style={{ height: '360px' }}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Timeline</span>
              <span className="text-[10px] font-mono text-text-muted">
                {payload?.metrics?.pacing_mikups?.length ?? 0} Events detected
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <WaveformVisualizer
                pacing={payload?.metrics?.pacing_mikups}
                duration={payload?.metrics?.spatial_metrics?.total_duration}
                audioSources={resolveStemAudioSources(payload)}
                outputDir={payload?.artifacts?.output_dir}
                diagnosticEvents={payload?.metrics?.diagnostic_events}
                ghostStemPaths={ghostStemPaths}
                highlightAtSecs={highlightAtSecs}
                onPlay={(time) => {
                  const [dxPath, musicPath, effectsPath] = resolvePlaybackStemPaths(payload, inputPath, workspaceDirectory);
                  if (dxPath) dspStream.startStream(dxPath, musicPath, effectsPath, time);
                }}
                onPause={() => stopDspStream()}
                onSeek={(time) => {
                  const [dxPath, musicPath, effectsPath] = resolvePlaybackStemPaths(payload, inputPath, workspaceDirectory);
                  if (dxPath) dspStream.startStream(dxPath, musicPath, effectsPath, time);
                }}
              />
            </div>
          </section>

          <section className="flex-1 px-6 py-5 min-h-[360px]">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Loudness Target</span>
              <div className="inline-flex border border-panel-border">
                {(Object.entries(LOUDNESS_TARGETS) as [LoudnessTargetId, { label: string; value: number }][]).map(
                  ([targetId, target]) => (
                    <button
                      key={targetId}
                      type="button"
                      onClick={() => setLoudnessTargetId(targetId)}
                      className={clsx(
                        'px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest transition-colors',
                        loudnessTargetId === targetId
                          ? 'bg-accent/10 text-accent'
                          : 'text-text-muted hover:text-text-main'
                      )}
                    >
                      {target.label}
                    </button>
                  )
                )}
              </div>
            </div>
            {payload && <MetricsPanel payload={payload} loudnessTarget={loudnessTarget} />}
          </section>
        </div>

        <aside className="lg:col-span-4 flex flex-col px-6 py-5 gap-6 min-h-0">
          {/* Live DSP meters — visible whenever a DSP stream is active */}
          {dspStream.currentFrame && (
            <div className="space-y-3 animate-in fade-in duration-300">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">Live Meters</span>
                <span className="text-[10px] font-mono text-text-muted tabular-nums">
                  {dspStream.currentFrame.timestamp_secs.toFixed(1)}s
                </span>
              </div>
              <div className="flex gap-4">
                <Vectorscope
                  lissajousPoints={dspStream.currentFrame.lissajous_points}
                  size={140}
                />
                <div className="flex-1 min-w-0">
                  <LiveMeters
                    frame={dspStream.currentFrame}
                    lra={dspStream.completePayload?.dialogue_loudness_range_lu}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Transcript Scrubber */}
          {payload?.transcription && payload.transcription.segments.length > 0 && (
            <div className="flex flex-col min-h-0 max-h-[340px]">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted">
                  Transcript
                </span>
                {dspStream.currentFrame && (
                  <span className="text-[10px] font-mono text-text-muted tabular-nums">
                    {dspStream.currentFrame.timestamp_secs.toFixed(1)}s
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0 overflow-hidden border border-panel-border p-3">
                <TranscriptScrubber
                  segments={payload.transcription.segments}
                  wordSegments={payload.transcription.word_segments}
                  currentTime={dspStream.currentFrame?.timestamp_secs ?? 0}
                  onSeek={(time) => {
                    const [dxPath, musicPath, effectsPath] = resolvePlaybackStemPaths(
                      payload,
                      inputPath,
                      workspaceDirectory,
                    );
                    if (dxPath) dspStream.startStream(dxPath, musicPath, effectsPath, time);
                  }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-col flex-1 min-h-0">
            <span className="text-[10px] uppercase tracking-widest font-bold text-text-muted mb-4">
              AI Bridge
            </span>
            <div className="flex-1 flex flex-col min-h-0">
              <AIBridge
                key={`${payload?.metadata?.source_file ?? 'none'}:${payload?.ai_report ?? 'none'}`}
                payload={payload}
                workspaceDir={workspaceDirectory}
                onSeek={(timeSecs) => {
                  const [dxPath, musicPath, effectsPath] = resolvePlaybackStemPaths(payload, inputPath, workspaceDirectory);
                  if (dxPath) dspStream.startStream(dxPath, musicPath, effectsPath, timeSecs);
                }}
                onHighlight={(timeSecs) => {
                  setHighlightAtSecs(null);
                  // Force re-trigger even if same value by briefly clearing
                  requestAnimationFrame(() => setHighlightAtSecs(timeSecs));
                }}
              />
            </div>
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
