import { Check, CheckCircle2, ClipboardCopy, FileJson2, FileText, Sparkles, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MikupPayload } from '../types';
import { clsx } from 'clsx';

interface AIBridgeProps {
  payload: MikupPayload | null;
}

interface EventItem {
  type: 'gap' | 'impact' | 'spatial';
  timestamp: number;
  summary: string;
  detail: string;
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0.00s';
  return `${seconds.toFixed(2)}s`;
}

function sanitizeGapContext(context: string | undefined): string {
  if (!context) return 'Detected silence interval.';
  if (/unknown/i.test(context)) return 'Detected silence interval.';
  return context;
}

function buildEvents(payload: MikupPayload): EventItem[] {
  const events: EventItem[] = [];
  const pacing = payload.metrics?.pacing_mikups ?? [];

  for (const gap of pacing.slice(0, 15)) {
    const gapSeconds = Math.max(0, gap.duration_ms / 1000);
    events.push({
      type: 'gap',
      timestamp: Math.max(0, gap.timestamp),
      summary: `${gapSeconds.toFixed(2)}s Silence`,
      detail: sanitizeGapContext(gap.context),
    });
  }

  const shortTerm = payload.metrics?.lufs_graph?.dialogue_raw?.short_term ?? [];
  let impactCount = 0;
  for (let i = 1; i < shortTerm.length; i += 1) {
    const jump = shortTerm[i] - shortTerm[i - 1];
    if (Math.abs(jump) >= 4) {
      events.push({
        type: 'impact',
        timestamp: i / 2,
        summary: `${jump > 0 ? '+' : ''}${jump.toFixed(1)} dB Jump`,
        detail: 'Dialogue short-term LUFS transition.',
      });
      impactCount += 1;
    }
    if (impactCount >= 6) break;
  }

  const stereoCorrelation = payload.metrics?.diagnostic_meters?.stereo_correlation;
  const stereoBalance = payload.metrics?.diagnostic_meters?.stereo_balance;
  const totalDuration = payload.metrics?.spatial_metrics?.total_duration ?? 0;

  if (typeof stereoCorrelation === 'number') {
    events.push({
      type: 'spatial',
      timestamp: Math.max(0, totalDuration / 2),
      summary: `Phase Correlation ${stereoCorrelation.toFixed(2)}`,
      detail: typeof stereoBalance === 'number'
        ? `Stereo balance ${stereoBalance.toFixed(2)}.`
        : 'Spatial field snapshot.',
    });
  }

  return events
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 24);
}

function buildClipboardContext(payload: MikupPayload, events: EventItem[]): string {
  const sourceFile = payload.metadata?.source_file?.split(/[\\/]/).pop() ?? 'unknown';
  const timestamp = payload.metadata?.timestamp ?? 'unknown';
  const duration = payload.metrics?.spatial_metrics?.total_duration ?? 0;
  const lufs = payload.metrics?.lufs_graph?.dialogue_raw?.integrated;
  const corr = payload.metrics?.diagnostic_meters?.stereo_correlation;
  const balance = payload.metrics?.diagnostic_meters?.stereo_balance;

  const semanticTags = (payload.semantics?.background_tags ?? [])
    .slice(0, 12)
    .map(tag => `- ${tag.label} (${(tag.score * 100).toFixed(0)}%)`)
    .join('\n') || '- None detected';

  const eventLines = events.slice(0, 15).map(
    (event, index) =>
      `${String(index + 1).padStart(2, '0')}. [${event.type.toUpperCase()}] ${formatSeconds(event.timestamp)} ${event.summary} :: ${event.detail}`
  ).join('\n') || 'No events detected';

  return [
    '# Mikup AI Bridge Context',
    '',
    '## Metadata',
    `- Filename: ${sourceFile}`,
    `- Timestamp: ${timestamp}`,
    `- Total Duration: ${formatSeconds(duration)}`,
    '',
    '## DSP Summary',
    `- Integrated LUFS (dialogue_raw): ${typeof lufs === 'number' ? lufs.toFixed(2) : 'N/A'}`,
    `- Average Phase Correlation: ${typeof corr === 'number' ? corr.toFixed(3) : 'N/A'}`,
    `- Stereo Balance: ${typeof balance === 'number' ? balance.toFixed(3) : 'N/A'}`,
    '',
    '## Semantic Tags (CLAP)',
    semanticTags,
    '',
    '## Events',
    eventLines,
    '',
    '## AI Director Report',
    payload.ai_report?.trim() || 'No AI Director report generated.',
  ].join('\n');
}

export function AIBridge({ payload }: AIBridgeProps) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'error'>('idle');
  const events = useMemo(() => (payload ? buildEvents(payload) : []), [payload]);

  if (!payload) return null;

  const handleCopyContext = async () => {
    const summary = buildClipboardContext(payload, events);
    try {
      await navigator.clipboard.writeText(summary);
      setCopied('ok');
    } catch {
      setCopied('error');
    }
    window.setTimeout(() => setCopied('idle'), 2200);
  };

  return (
    <div className="flex h-full flex-col gap-4 animate-in fade-in slide-in-from-right-4 duration-500">
      <button
        onClick={handleCopyContext}
        className={clsx(
          'w-full border px-4 py-3 text-left transition-colors',
          copied === 'ok' && 'border-[oklch(0.8_0.11_155)] bg-[oklch(0.97_0.02_150)]',
          copied === 'error' && 'border-[oklch(0.72_0.17_25)] bg-[oklch(0.97_0.02_30)]',
          copied === 'idle' && 'border-panel-border bg-[oklch(0.985_0.008_250)] hover:border-[oklch(0.72_0.1_255)]'
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-text-main">
            {copied === 'ok' ? <Check size={14} /> : <ClipboardCopy size={14} />}
            Copy Context
          </span>
          <span className="text-[10px] font-mono text-text-muted">
            {copied === 'ok' ? 'Clipboard ready' : copied === 'error' ? 'Clipboard blocked' : 'Condensed payload'}
          </span>
        </div>
        <p className="mt-1 text-[10px] text-text-muted">
          Includes metadata, DSP diagnostics, semantic tags, events, and AI director markdown.
        </p>
      </button>

      <section className="border border-panel-border bg-[oklch(0.99_0.003_250)] p-3">
        <div className="mb-3 flex items-center gap-2">
          <CheckCircle2 size={14} className="text-[oklch(0.64_0.14_150)]" />
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-main">Bridge Files</span>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between border border-panel-border bg-background px-2 py-2">
            <span className="flex items-center gap-2 text-[10px] font-mono text-text-main">
              <FileJson2 size={12} className="text-[oklch(0.58_0.13_240)]" />
              data/output/mikup_payload.json
            </span>
            <span className="text-[9px] font-bold uppercase tracking-wider text-[oklch(0.58_0.13_240)]">READY</span>
          </div>
          <div className="flex items-center justify-between border border-panel-border bg-background px-2 py-2">
            <span className="flex items-center gap-2 text-[10px] font-mono text-text-main">
              <FileText size={12} className="text-[oklch(0.62_0.12_205)]" />
              .mikup_context.md
            </span>
            <span className="text-[9px] font-bold uppercase tracking-wider text-[oklch(0.62_0.12_205)]">READY</span>
          </div>
        </div>
      </section>

      {payload.ai_report && (
        <section className="border border-panel-border bg-[oklch(0.99_0.005_250)] p-3">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles size={13} className="text-[oklch(0.65_0.14_290)]" />
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-main">AI Director Report</span>
          </div>
          <div className="max-h-52 overflow-y-auto space-y-1 text-[10px] leading-relaxed text-text-muted font-mono pr-1">
            {payload.ai_report.split('\n').map((line, i) => {
              if (/^#{1,3}\s/.test(line)) {
                return <p key={i} className="font-bold text-text-main mt-2">{line.replace(/^#+\s/, '')}</p>;
              }
              if (/^[-*]\s/.test(line)) {
                return <p key={i} className="pl-2">· {line.slice(2)}</p>;
              }
              if (line.trim() === '') {
                return <div key={i} className="h-1" />;
              }
              return <p key={i}>{line}</p>;
            })}
          </div>
        </section>
      )}

      <section className="border border-panel-border bg-[oklch(0.99_0.004_250)] p-3">
        <div className="mb-2 flex items-center gap-2">
          <Terminal size={13} className="text-accent" />
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-main">CLI Status</span>
        </div>
        <p className="mb-2 text-[10px] text-text-muted">
          External agents should read `.mikup_context.md` first, then inspect `mikup_payload.json` for deeper fields.
        </p>
        <div className="space-y-1 border border-panel-border bg-background p-2 font-mono text-[10px] text-text-main">
          <p>Run: <span className="text-[oklch(0.45_0.14_260)]">gemini "Analyze .mikup_context.md"</span></p>
          <p>Run: <span className="text-[oklch(0.45_0.14_260)]">claude "Review .mikup_context.md + mikup_payload.json"</span></p>
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col border border-panel-border bg-[oklch(0.99_0.005_250)]">
        <div className="flex items-center justify-between border-b border-panel-border px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-main">Event Stream</span>
          <span className="text-[9px] font-mono text-text-muted">{events.length} events</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {events.length === 0 && (
            <p className="text-[10px] font-mono text-text-muted">No events detected in this run.</p>
          )}
          <div className="space-y-2">
            {events.map((event, index) => (
              <div key={`${event.type}-${event.timestamp}-${index}`} className="grid grid-cols-[62px_1fr] gap-3 border-l-2 border-panel-border pl-2">
                <span className="pt-0.5 text-[9px] font-mono text-text-muted">
                  {formatSeconds(event.timestamp)}
                </span>
                <div className="font-mono">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-text-main">
                    <span
                      className={clsx(
                        'mr-2 inline-block h-1.5 w-1.5 rounded-full',
                        event.type === 'gap' && 'bg-[oklch(0.65_0.12_260)]',
                        event.type === 'impact' && 'bg-[oklch(0.68_0.14_70)]',
                        event.type === 'spatial' && 'bg-[oklch(0.62_0.13_190)]'
                      )}
                    />
                    [{event.type.toUpperCase()}] {event.summary}
                  </p>
                  <p className="text-[10px] leading-snug text-text-muted">{event.detail}</p>
                </div>
              </div>
            ))}
            <div className="h-8 bg-gradient-to-t from-background to-transparent" />
          </div>
        </div>
      </section>
    </div>
  );
}
