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

export type DirectorChatRole = 'user' | 'ai';

export interface DirectorChatMessage {
  role: DirectorChatRole;
  text: string;
}

export interface AudioArtifacts {
  stem_paths: string[];
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

export interface MikupPayload {
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
    `data/processed/${baseName}_Vocals.wav`,
    `data/processed/${baseName}_Dry_Vocals.wav`,
    `data/processed/${baseName}_Instrumental.wav`,
    `data/processed/${baseName}_Reverb.wav`,
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
  if (isRecord(raw.artifacts)) {
    collectStemPaths(raw.artifacts.stem_paths, stemPaths);
    collectStemPaths(raw.artifacts.generated_stems, stemPaths);
    collectStemPaths(raw.artifacts.stems, stemPaths);
  }
  if (stemPaths.size > 0) {
    payload.artifacts = { stem_paths: Array.from(stemPaths).filter(isLikelyLocalPath) };
  }

  return payload;
}

export function resolveStemAudioSources(payload: MikupPayload | null): string[] {
  if (!payload) return [];

  const stemPaths = new Set<string>();
  for (const path of payload.artifacts?.stem_paths ?? []) {
    if (path.trim() && isLikelyLocalPath(path)) {
      stemPaths.add(path.trim());
    }
  }

  if (payload.metadata?.source_file) {
    for (const path of deriveStemPathsFromSource(payload.metadata.source_file)) {
      stemPaths.add(path);
    }
  }

  return Array.from(stemPaths);
}

