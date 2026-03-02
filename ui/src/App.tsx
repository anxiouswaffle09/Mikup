import { Suspense, use, useActionState, useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { commands } from '@bindings';
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
import { StorageGauge } from './components/StorageGauge';
import { RedoStageModal } from './components/RedoStageModal';
import { useDspStream } from './hooks/useDspStream';
import {
  parseMikupPayload,
  resolveStemAudioSources,
  type MikupPayload,
  type PipelineStageDefinition,
  type LufsSeries,
  type AppConfig,
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

// Stable module-level promise: resolves to null on error so Suspense never rejects.
const configPromise = commands.getAppConfig()
  .then((r) => (r.status === 'ok' ? r.data as AppConfig : null))
  .catch(() => null);

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

function AppContent() {
  const initialConfig = use(configPromise);
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
  // isPreparingWorkflow is derived from useActionState isPending below
  const [loudnessTargetId, setLoudnessTargetId] = useState<LoudnessTargetId>('streaming');
  const [config, setConfig] = useState<AppConfig | null>(
    initialConfig?.default_projects_dir ? initialConfig : null,
  );
  const [showFirstRunModal, setShowFirstRunModal] = useState(!initialConfig?.default_projects_dir);
  const [highlightAtSecs, setHighlightAtSecs] = useState<number | null>(null);
  const [redoTargetStage, setRedoTargetStage] = useState<PipelineStageDefinition | null>(null);
  const [isRedoing, setIsRedoing] = useState(false);
  const [showRedoMenu, setShowRedoMenu] = useState(false);
  const [storageLastUpdated, setStorageLastUpdated] = useState(0);

  const loudnessTarget = LOUDNESS_TARGETS[loudnessTargetId];

  const dspStream = useDspStream();
  const { startStream: startDspStream, stopStream: stopDspStream } = dspStream;

  const ghostStemPaths = useMemo(() => {
    const [, ghostMusic, ghostEffects] = resolvePlaybackStemPaths(payload, inputPath, workspaceDirectory);
    return {
      musicPath: ghostMusic || undefined,
      effectsPath: ghostEffects || undefined,
    };
  }, [payload, inputPath, workspaceDirectory]);

  const audioSources = useMemo(
    () => resolveStemAudioSources(payload, config?.project_root ?? undefined),
    [payload, config?.project_root],
  );

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
          startDspStream(dxPath, musicPath, effectsPath, event.payload.time_secs, inputPath ?? '');
        }
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [payload, inputPath, workspaceDirectory, startDspStream]);

  // --- useActionState: first-run folder picker ---
  const [, firstRunAction, isFirstRunSaving] = useActionState(
    async (_prev: null) => {
      setError(null);
      const selectedDir = await open({
        multiple: false,
        directory: true,
        title: 'Choose your default Mikup projects folder',
      });
      if (typeof selectedDir !== 'string') return null;
      try {
        const result = await commands.setDefaultProjectsDir(selectedDir);
        if (result.status === 'error') {
          setError(result.error);
          return null;
        }
        setConfig(result.data as AppConfig);
        setShowFirstRunModal(false);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return null;
    },
    null,
  );
  const handleFirstRunSave = () => { void firstRunAction(); };

  // --- useActionState: change default folder ---
  const [, changeDefaultFolderAction] = useActionState(
    async (_prev: null) => {
      const selectedDir = await open({
        multiple: false,
        directory: true,
        title: 'Change default Mikup projects folder',
      });
      if (typeof selectedDir !== 'string') return null;
      try {
        const result = await commands.setDefaultProjectsDir(selectedDir);
        if (result.status === 'error') {
          setError(result.error);
          return null;
        }
        setConfig(result.data as AppConfig);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return null;
    },
    null,
  );
  const handleChangeDefaultFolder = () => { void changeDefaultFolderAction(); };

  // --- useActionState: setup_project_workspace (isPending replaces isPreparingWorkflow) ---
  const [, startWorkspaceAction, isPreparingWorkflow] = useActionState(
    async (_prev: null, { filePath, overrideDir }: { filePath: string; overrideDir?: string }) => {
      if (!filePath.trim()) {
        setError('Selected audio file path is invalid.');
        return null;
      }
      if (!config) {
        setError('App config not loaded. Restart the application.');
        return null;
      }
      const baseDir = overrideDir ?? config.default_projects_dir;
      try {
        setError(null);
        setPipelineErrors([]);
        const wsResult = await commands.setupProjectWorkspace(filePath, baseDir);
        if (wsResult.status === 'error') {
          setError(wsResult.error);
          return null;
        }
        const workspace = wsResult.data;
        setInputPath(workspace.copied_input_path);
        setWorkspaceDirectory(workspace.workspace_dir);
        setRunningStageIndex(null);

        const psResult = await commands.getPipelineState(workspace.workspace_dir);
        const resumeCount = psResult.status === 'ok' ? psResult.data : 0;
        setCompletedStageCount(resumeCount);

        if (resumeCount > 0 && resumeCount < PIPELINE_STAGES.length) {
          const nextStage = PIPELINE_STAGES[resumeCount];
          setWorkflowMessage(
            `Previous progress found. Resuming from Stage ${resumeCount + 1}: ${nextStage.label}.`
          );
          setProgress({ stage: 'INIT', progress: 0, message: `Resuming from stage ${resumeCount + 1}.` });
        } else if (resumeCount >= PIPELINE_STAGES.length) {
          try {
            const payloadResult = await commands.readOutputPayload(workspace.workspace_dir);
            if (payloadResult.status === 'error') throw new Error(payloadResult.error);
            const parsed = parseMikupPayload(JSON.parse(payloadResult.data));
            setPayload(parsed);
            setView('analysis');
            return null;
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
      }
      return null;
    },
    null,
  );
  const handleStartNewProcess = (filePath: string, overrideDir?: string) => {
    void startWorkspaceAction({ filePath, overrideDir });
  };

  // --- useActionState: run_pipeline_stage ---
  const [, dispatchRunStage, isRunningStage] = useActionState(
    async (_prev: null, input: { stageIndex: number; force?: boolean }) => {
      await runStageImpl(input.stageIndex, input.force ?? false);
      return null;
    },
    null,
  );

  const runStageImpl = async (stageIndex: number, force = false): Promise<void> => {
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
        const stemsResult = await commands.getStems(workspaceDirectory);
        if (stemsResult.status === 'error') throw new Error(stemsResult.error);
        const stems = stemsResult.data as Record<string, string | null>;

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
        const scanResultRaw = await commands.generateStaticMap(workspaceDirectory, stemPaths);
        if (scanResultRaw.status === 'error') throw new Error(scanResultRaw.error);
        const scanResult = scanResultRaw.data as unknown as { lufs_graph: Record<string, LufsSeries> };

        // Persist stage state so get_pipeline_state returns 3 on resume.
        await commands.markDspComplete(workspaceDirectory).catch(() => {});

        const nextCount = Math.max(completedStageCount, DSP_STAGE_INDEX + 1);
        setCompletedStageCount((prev) => Math.max(prev, DSP_STAGE_INDEX + 1));
        setRunningStageIndex(null);

        // Read the payload persisted by Python stages, merge in the Turbo Scan LUFS graph.
        try {
          const payloadResult = await commands.readOutputPayload(workspaceDirectory);
          if (payloadResult.status === 'error') throw new Error(payloadResult.error);
          const parsed = parseMikupPayload(JSON.parse(payloadResult.data));

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

        setStorageLastUpdated(Date.now());
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
      const runResult = await commands.runPipelineStage(
        inputPath,
        workspaceDirectory,
        stage.id,
        fastMode,
        force,
      );
      if (runResult.status === 'error') throw new Error(runResult.error);

      const nextCompletedCount = force
        ? stageIndex + 1
        : Math.max(completedStageCount, stageIndex + 1);
      setCompletedStageCount((prev) => (force ? stageIndex + 1 : Math.max(prev, stageIndex + 1)));
      setRunningStageIndex(null);
      setStorageLastUpdated(Date.now());

      if (nextCompletedCount >= PIPELINE_STAGES.length) {
        setWorkflowMessage('All stages complete. Loading analysis payload...');
        const finalPayloadResult = await commands.readOutputPayload(workspaceDirectory);
        if (finalPayloadResult.status === 'error') throw new Error(finalPayloadResult.error);
        const parsed = parseMikupPayload(JSON.parse(finalPayloadResult.data));
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

  const handleRunNextStage = () => {
    void dispatchRunStage({ stageIndex: completedStageCount });
  };

  const handleRerunStage = (stageIndex: number) => {
    void dispatchRunStage({ stageIndex, force: true });
  };

  const handleRedoStage = async (stage: PipelineStageDefinition): Promise<void> => {
    if (!inputPath || !workspaceDirectory) return;

    setIsRedoing(true);
    try {
      const redoResult = await commands.redoPipelineStage(
        workspaceDirectory,
        stage.id.toLowerCase(),
        inputPath,
      );
      if (redoResult.status === 'error') throw new Error(redoResult.error);

      const stageIndex = PIPELINE_STAGES.findIndex((s) => s.id === stage.id);
      // Reset completed count to the redo target so processing view re-runs from there.
      setCompletedStageCount((prev) => Math.min(prev, stageIndex));

      // Clear in-memory payload data for the invalidated stages.
      if (stage.id === 'SEPARATION') {
        setPayload(null);
      } else if (stage.id === 'TRANSCRIPTION' || stage.id === 'DSP') {
        setPayload((prev) =>
          prev
            ? {
                ...prev,
                transcription: undefined,
                metrics: {
                  pacing_mikups: [],
                  spatial_metrics: { total_duration: 0 },
                  impact_metrics: {},
                },
              }
            : null,
        );
      } else if (stage.id === 'SEMANTICS') {
        setPayload((prev) => (prev ? { ...prev, semantics: undefined } : null));
      } else if (stage.id === 'DIRECTOR') {
        setPayload((prev) =>
          prev ? { ...prev, ai_report: undefined, is_complete: false } : null,
        );
      }

      setRedoTargetStage(null);
      setShowRedoMenu(false);
      setStorageLastUpdated(Date.now());
      setView('processing');
      // Auto-start re-run from the redo target stage.
      void dispatchRunStage({ stageIndex });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRedoing(false);
    }
  };

  const handleSelectProject = (projectPayload: MikupPayload) => {
    setError(null);
    setPayload(projectPayload);
    // Restore workspace context so resolvePlaybackStemPaths can resolve relative stem paths.
    let workspaceDir = projectPayload.artifacts?.output_dir ?? null;
    if (
      workspaceDir &&
      config?.project_root &&
      !workspaceDir.startsWith('/') &&
      !/^[a-zA-Z]:[\\/]/.test(workspaceDir)
    ) {
      workspaceDir = `${config.project_root}/${workspaceDir}`;
    }
    setWorkspaceDirectory(workspaceDir);
    setInputPath(projectPayload.metadata?.source_file ?? null);
    setView('analysis');
  };

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
            disabled={isFirstRunSaving}
            className="w-full border border-accent text-accent px-4 py-3 text-sm font-medium hover:bg-accent/5 transition-colors disabled:opacity-50"
          >
            {isFirstRunSaving ? 'Saving…' : 'Choose Folder…'}
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
        {config?.default_projects_dir && (
          <div className="fixed bottom-4 left-4 w-52 shadow-lg">
            <StorageGauge
              workspacePath={config.default_projects_dir}
              lastUpdated={storageLastUpdated}
            />
          </div>
        )}
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
              disabled={isRunningStage}
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
                        className={`w-1.5 h-1.5 rounded-full ${isComplete || isRunning || isReady ? 'bg-accent' : 'bg-panel-border'}`}
                      />
                      <span className={`text-[10px] font-mono ${isRunning || isReady ? 'text-text-main' : 'text-text-muted opacity-50'}`}>
                        {stage.label}
                      </span>
                      {isComplete && (
                        <button
                          type="button"
                          onClick={() => handleRerunStage(i)}
                          disabled={isRunningStage}
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
              disabled={isRunningStage || !nextStage}
              className={clsx(
                'w-full border px-4 py-3 text-sm font-medium transition-colors',
                isRunningStage || !nextStage
                  ? 'border-panel-border text-text-muted cursor-not-allowed'
                  : 'border-accent text-accent hover:bg-accent/5'
              )}
            >
              {isRunningStage && runningStageIndex !== null
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
          {/* Re-process dropdown — only shown when workspace is available */}
          {workspaceDirectory && inputPath && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowRedoMenu((v) => !v)}
                className="text-[10px] font-mono text-text-muted hover:text-text-main border border-panel-border px-3 py-1.5 transition-colors"
              >
                Re-process ▾
              </button>
              {showRedoMenu && (
                <>
                  {/* Transparent backdrop to close menu on outside click */}
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowRedoMenu(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 border border-panel-border bg-background z-20 min-w-[200px] shadow-lg">
                    {PIPELINE_STAGES.map((stage) => (
                      <button
                        key={stage.id}
                        type="button"
                        onClick={() => {
                          setRedoTargetStage(stage);
                          setShowRedoMenu(false);
                        }}
                        className="w-full text-left px-4 py-2.5 text-[11px] font-mono text-text-muted hover:text-text-main hover:bg-panel-border/30 transition-colors"
                      >
                        Redo {stage.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
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
          <section className="flex flex-col px-6 py-5 border-b border-panel-border h-[--height-timeline]">
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
                audioSources={audioSources}
                outputDir={payload?.artifacts?.output_dir}
                diagnosticEvents={payload?.metrics?.diagnostic_events}
                ghostStemPaths={ghostStemPaths}
                highlightAtSecs={highlightAtSecs}
                currentTimeSecs={dspStream.currentFrame?.timestamp_secs}
                onPlay={(time) => {
                  const [dxPath, musicPath, effectsPath] = resolvePlaybackStemPaths(payload, inputPath, workspaceDirectory);
                  if (dxPath) dspStream.startStream(dxPath, musicPath, effectsPath, time, inputPath ?? '');
                }}
                onPause={() => stopDspStream()}
                onScrub={(time) => dspStream.seekStream(time)}
                onSeek={(time) => {
                  const [dxPath, musicPath, effectsPath] = resolvePlaybackStemPaths(payload, inputPath, workspaceDirectory);
                  if (dxPath) dspStream.startStream(dxPath, musicPath, effectsPath, time, inputPath ?? '');
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
                    if (dxPath) dspStream.startStream(dxPath, musicPath, effectsPath, time, inputPath ?? '');
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
                  if (dxPath) dspStream.startStream(dxPath, musicPath, effectsPath, timeSecs, inputPath ?? '');
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
      <RedoStageModal
        stage={redoTargetStage}
        onConfirm={() => {
          if (redoTargetStage) void handleRedoStage(redoTargetStage);
        }}
        onClose={() => setRedoTargetStage(null)}
        isLoading={isRedoing}
      />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={null}>
      <AppContent />
    </Suspense>
  );
}
