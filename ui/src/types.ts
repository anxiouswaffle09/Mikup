export type PipelineStageId = 'SEPARATION' | 'TRANSCRIPTION' | 'DSP' | 'SEMANTICS' | 'DIRECTOR';

export interface PipelineStageDefinition {
  id: PipelineStageId;
  label: string;
}

export interface PacingMikup {
  timestamp: number;
  duration_ms: number;
  context: string;
}

export interface SemanticTag {
  label: string;
  score: number;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface WordSegment {
  word: string;
  start: number;
  end: number;
  speaker?: string;
  score?: number;
}

export interface AudioArtifacts {
  stem_paths: string[];
  output_dir?: string;
  stage_state?: string;
  stems?: string;
  transcription?: string;
  semantics?: string;
  dsp_metrics?: string;
}

export interface LufsSeries {
  integrated: number;
  momentary: number[];
  short_term: number[];
}

export interface DiagnosticMetrics {
  intelligibility_snr: number;
  stereo_correlation: number;
  stereo_balance: number;
}

export type DiagnosticEventSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DiagnosticEvent {
  timestamp_secs: number;
  duration_secs: number;
  event_type: string;
  severity: DiagnosticEventSeverity;
}

/**
 * Emitted by the `dsp-frame` Tauri event at up to 60 FPS during stream_audio_metrics.
 * Matches the DspFramePayload struct in ui/src-tauri/src/lib.rs exactly.
 */
export interface DspFramePayload {
  frame_index: number;
  timestamp_secs: number;
  // Loudness — dialogue stem
  dialogue_momentary_lufs: number;
  dialogue_short_term_lufs: number;
  dialogue_true_peak_dbtp: number;
  dialogue_crest_factor: number;
  // Loudness — background stem
  background_momentary_lufs: number;
  background_short_term_lufs: number;
  background_true_peak_dbtp: number;
  background_crest_factor: number;
  // Spatial
  phase_correlation: number;
  lissajous_points: [number, number][]; // [x, y] pairs, max 128 per frame
  // Spectral
  dialogue_centroid_hz: number;
  background_centroid_hz: number;
  speech_pocket_masked: boolean;
  dialogue_speech_energy: number;
  background_speech_energy: number;
  snr_db: number;
}

/**
 * Emitted by the `dsp-complete` Tauri event once at natural EOF.
 * Matches the DspCompletePayload struct in ui/src-tauri/src/lib.rs exactly.
 */
export interface DspCompletePayload {
  total_frames: number;
  dialogue_integrated_lufs: number;
  dialogue_loudness_range_lu: number;
  background_integrated_lufs: number;
  background_loudness_range_lu: number;
}

export interface MikupPayload {
  is_complete?: boolean;
  metadata?: {
    source_file: string;
    pipeline_version: string;
    timestamp?: string;
  };
  transcription?: {
    segments: TranscriptionSegment[];
    word_segments: WordSegment[];
  };
  metrics?: {
    pacing_mikups: PacingMikup[];
    spatial_metrics: {
      total_duration: number;
      vocal_clarity?: number;
      reverb_density?: number;
      vocal_width?: number;
      reverb_width?: number;
    };
    impact_metrics: {
      ducking_intensity?: number;
    };
    lufs_graph?: Record<string, LufsSeries>;
    diagnostic_meters?: DiagnosticMetrics;
    diagnostic_events?: DiagnosticEvent[];
  };
  semantics?: {
    background_tags: SemanticTag[];
  };
  artifacts?: AudioArtifacts;
  ai_report?: string;
}

export interface HistoryEntry {
  id: string;
  filename: string;
  date: string;
  duration: number;
  payload: MikupPayload;
}

export interface AppConfig {
  default_projects_dir: string;
}

export interface WorkspaceSetupResult {
  workspace_dir: string;
  copied_input_path: string;
}

type PayloadRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PayloadRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parsePacingMikup(value: unknown): PacingMikup | null {
  if (!isRecord(value)) return null;
  const timestamp = asNumber(value.timestamp);
  const durationMs = asNumber(value.duration_ms);
  if (timestamp === undefined || durationMs === undefined) return null;
  return {
    timestamp,
    duration_ms: durationMs,
    context: asString(value.context) ?? 'Unknown context',
  };
}

function parseSemanticTag(value: unknown): SemanticTag | null {
  if (!isRecord(value)) return null;
  const label = asString(value.label);
  const score = asNumber(value.score);
  if (!label || score === undefined) return null;
  return { label, score };
}

function parseTranscriptionSegment(value: unknown): TranscriptionSegment | null {
  if (!isRecord(value)) return null;
  const start = asNumber(value.start);
  const end = asNumber(value.end);
  if (start === undefined || end === undefined) return null;
  return {
    start,
    end,
    text: asString(value.text) ?? '',
    speaker: asString(value.speaker),
  };
}

function parseWordSegment(value: unknown): WordSegment | null {
  if (!isRecord(value)) return null;
  const start = asNumber(value.start);
  const end = asNumber(value.end);
  const word = asString(value.word);
  if (start === undefined || end === undefined || !word) return null;
  const parsed: WordSegment = { word, start, end };
  const speaker = asString(value.speaker);
  const score = asNumber(value.score);
  if (speaker) parsed.speaker = speaker;
  if (score !== undefined) parsed.score = score;
  return parsed;
}

function collectStemPaths(value: unknown, target: Set<string>) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const path = asString(entry)?.trim();
      if (path) target.add(path);
    }
    return;
  }

  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      const path = asString(entry)?.trim();
      if (path) target.add(path);
    }
  }
}

function isLikelyLocalPath(path: string): boolean {
  return !/^https?:\/\//i.test(path);
}

function deriveStemPathsFromSource(sourceFile: string): string[] {
  const filename = sourceFile.replace(/^.*[\\/]/, '');
  const baseName = filename.replace(/\.[^/.]+$/, '');
  if (!baseName) return [];
  return [
    `${baseName}_DX.wav`,
    `${baseName}_Music.wav`,
    `${baseName}_Effects.wav`,
  ];
}

export function parseMikupPayload(raw: unknown): MikupPayload {
  if (!isRecord(raw)) {
    throw new Error('Invalid payload format: expected an object.');
  }

  const payload: MikupPayload = {};

  if (isRecord(raw.metadata)) {
    const sourceFile = asString(raw.metadata.source_file);
    const pipelineVersion = asString(raw.metadata.pipeline_version);
    if (sourceFile && pipelineVersion) {
      payload.metadata = {
        source_file: sourceFile,
        pipeline_version: pipelineVersion,
        timestamp: asString(raw.metadata.timestamp),
      };
    }
  }

  if (isRecord(raw.transcription)) {
    payload.transcription = {
      segments: Array.isArray(raw.transcription.segments)
        ? raw.transcription.segments
            .map(parseTranscriptionSegment)
            .filter((segment): segment is TranscriptionSegment => segment !== null)
        : [],
      word_segments: Array.isArray(raw.transcription.word_segments)
        ? raw.transcription.word_segments
            .map(parseWordSegment)
            .filter((segment): segment is WordSegment => segment !== null)
        : [],
    };
  }

  if (isRecord(raw.metrics)) {
    const spatialMetrics: NonNullable<MikupPayload['metrics']>['spatial_metrics'] = {
      total_duration: 0,
    };
    if (isRecord(raw.metrics.spatial_metrics)) {
      const totalDuration = asNumber(raw.metrics.spatial_metrics.total_duration);
      if (totalDuration !== undefined) spatialMetrics.total_duration = totalDuration;
      const vocalClarity = asNumber(raw.metrics.spatial_metrics.vocal_clarity);
      const reverbDensity = asNumber(raw.metrics.spatial_metrics.reverb_density);
      const vocalWidth = asNumber(raw.metrics.spatial_metrics.vocal_width);
      const reverbWidth = asNumber(raw.metrics.spatial_metrics.reverb_width);
      if (vocalClarity !== undefined) spatialMetrics.vocal_clarity = vocalClarity;
      if (reverbDensity !== undefined) spatialMetrics.reverb_density = reverbDensity;
      if (vocalWidth !== undefined) spatialMetrics.vocal_width = vocalWidth;
      if (reverbWidth !== undefined) spatialMetrics.reverb_width = reverbWidth;
    }

    const impactMetrics: NonNullable<MikupPayload['metrics']>['impact_metrics'] = {};
    if (isRecord(raw.metrics.impact_metrics)) {
      const ducking = asNumber(raw.metrics.impact_metrics.ducking_intensity);
      if (ducking !== undefined) impactMetrics.ducking_intensity = ducking;
    }

    payload.metrics = {
      pacing_mikups: Array.isArray(raw.metrics.pacing_mikups)
        ? raw.metrics.pacing_mikups
            .map(parsePacingMikup)
            .filter((item): item is PacingMikup => item !== null)
        : [],
      spatial_metrics: spatialMetrics,
      impact_metrics: impactMetrics,
    };

    if (isRecord(raw.metrics.lufs_graph)) {
      payload.metrics.lufs_graph = {};
      for (const [key, value] of Object.entries(raw.metrics.lufs_graph)) {
        if (isRecord(value)) {
          payload.metrics.lufs_graph[key] = {
            integrated: asNumber(value.integrated) ?? -70,
            momentary: Array.isArray(value.momentary) ? (value.momentary as number[]) : [],
            short_term: Array.isArray(value.short_term) ? (value.short_term as number[]) : [],
          };
        }
      }
    }

    if (isRecord(raw.metrics.diagnostic_meters)) {
      payload.metrics.diagnostic_meters = {
        intelligibility_snr: asNumber(raw.metrics.diagnostic_meters.intelligibility_snr) ?? 0,
        stereo_correlation: asNumber(raw.metrics.diagnostic_meters.stereo_correlation) ?? 1.0,
        stereo_balance: asNumber(raw.metrics.diagnostic_meters.stereo_balance) ?? 0,
      };
    }

    if (Array.isArray(raw.metrics.diagnostic_events)) {
      payload.metrics.diagnostic_events = raw.metrics.diagnostic_events
        .filter(isRecord)
        .map((e) => ({
          timestamp_secs: asNumber(e.timestamp_secs) ?? 0,
          duration_secs: asNumber(e.duration_secs) ?? 0,
          event_type: asString(e.event_type) ?? '',
          severity: (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(asString(e.severity) ?? '')
            ? asString(e.severity)
            : 'LOW') as DiagnosticEventSeverity,
        }));
    }
  }

  if (isRecord(raw.semantics)) {
    payload.semantics = {
      background_tags: Array.isArray(raw.semantics.background_tags)
        ? raw.semantics.background_tags
            .map(parseSemanticTag)
            .filter((tag): tag is SemanticTag => tag !== null)
        : [],
    };
  }

  if (typeof raw.ai_report === 'string') {
    payload.ai_report = raw.ai_report;
  }

  const stemPaths = new Set<string>();
  collectStemPaths(raw.stems, stemPaths);
  collectStemPaths(raw.generated_stems, stemPaths);
  let outputDir: string | undefined;
  if (typeof raw.is_complete === 'boolean') {
    payload.is_complete = raw.is_complete;
  }

  if (isRecord(raw.artifacts)) {
    collectStemPaths(raw.artifacts.stem_paths, stemPaths);
    collectStemPaths(raw.artifacts.generated_stems, stemPaths);
    collectStemPaths(raw.artifacts.stems, stemPaths);
    outputDir = asString(raw.artifacts.output_dir);
  }
  const resolvedStems = Array.from(stemPaths).filter(isLikelyLocalPath);
  if (resolvedStems.length > 0 || outputDir) {
    payload.artifacts = { stem_paths: resolvedStems };
    if (outputDir) payload.artifacts.output_dir = outputDir;
    if (isRecord(raw.artifacts)) {
      const stageState = asString(raw.artifacts.stage_state);
      const stems = asString(raw.artifacts.stems);
      const transcription = asString(raw.artifacts.transcription);
      const semantics = asString(raw.artifacts.semantics);
      const dspMetrics = asString(raw.artifacts.dsp_metrics);
      if (stageState) payload.artifacts.stage_state = stageState;
      if (stems) payload.artifacts.stems = stems;
      if (transcription) payload.artifacts.transcription = transcription;
      if (semantics) payload.artifacts.semantics = semantics;
      if (dspMetrics) payload.artifacts.dsp_metrics = dspMetrics;
    }
  }

  return payload;
}

function resolveToAbsolute(path: string, outputDir?: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  // Already absolute (Unix or Windows)
  if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
  // Relative — prepend output_dir if available
  if (outputDir) return `${outputDir}/${trimmed}`;
  return trimmed;
}

export function resolveStemAudioSources(payload: MikupPayload | null): string[] {
  if (!payload) return [];

  const outputDir = payload.artifacts?.output_dir;
  const stemPaths = new Set<string>();

  for (const path of payload.artifacts?.stem_paths ?? []) {
    const trimmed = path.trim();
    if (!trimmed || !isLikelyLocalPath(trimmed)) continue;
    stemPaths.add(resolveToAbsolute(trimmed, outputDir));
  }

  if (stemPaths.size === 0 && payload.metadata?.source_file) {
    const stemsDir = outputDir ? `${outputDir}/stems` : undefined;
    for (const path of deriveStemPathsFromSource(payload.metadata.source_file)) {
      stemPaths.add(resolveToAbsolute(path, stemsDir));
    }
  }

  // DX stem is primary — sort it first so WaveformVisualizer loads it as the default waveform.
  return Array.from(stemPaths).sort((a, b) => {
    const aIsDX = /_DX\./i.test(a);
    const bIsDX = /_DX\./i.test(b);
    if (aIsDX && !bIsDX) return -1;
    if (!aIsDX && bIsDX) return 1;
    return 0;
  });
}

export function parseHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!isRecord(raw)) return null;

  const id = asString(raw.id);
  if (!id) return null;

  let payload: MikupPayload = {};
  try {
    payload = parseMikupPayload(raw.payload);
  } catch {
    payload = {};
  }

  return {
    id,
    filename: asString(raw.filename) || 'Unknown',
    date: asString(raw.date) || new Date().toISOString(),
    duration: asNumber(raw.duration) ?? 0,
    payload,
  };
}
