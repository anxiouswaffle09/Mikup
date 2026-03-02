import type { PipelineStageDefinition } from '../types';

/**
 * Maps each stage (lowercase) to the human-readable names of all downstream stages
 * that will ALSO be invalidated when that stage is redone.
 * Mirrors the cascade logic in `redo_pipeline_stage` (Rust) and `--redo-stage` (Python).
 */
const STAGE_CASCADE: Record<string, string[]> = {
  separation: ['Transcription & Diarization', 'DSP', 'Semantics', 'AI Director'],
  transcription: ['DSP', 'Semantics', 'AI Director'],
  dsp: ['Semantics', 'AI Director'],
  semantics: ['AI Director'],
  director: [],
};

interface RedoStageModalProps {
  /** The stage to confirm redo for. Pass null to hide the modal. */
  stage: PipelineStageDefinition | null;
  onConfirm: () => void;
  onClose: () => void;
  isLoading?: boolean;
}

export function RedoStageModal({ stage, onConfirm, onClose, isLoading }: RedoStageModalProps) {
  if (!stage) return null;

  const stageKey = stage.id.toLowerCase();
  const cascade = STAGE_CASCADE[stageKey] ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="border border-panel-border bg-background max-w-sm w-full mx-4 p-6 space-y-5 animate-in fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <p className="text-[9px] uppercase tracking-widest font-bold text-red-400 mb-1">
            Destructive Action
          </p>
          <h3 className="text-base font-semibold text-text-main">Redo {stage.label}</h3>
        </div>

        <p className="text-[12px] font-mono text-text-muted leading-relaxed">
          This will permanently delete all data from{' '}
          <strong className="text-text-main">{stage.label}</strong>
          {cascade.length > 0 && (
            <>
              {' '}and every stage that follows:{' '}
              <strong className="text-text-main">{cascade.join(', ')}</strong>
            </>
          )}
          . This cannot be undone.
        </p>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="flex-1 border border-panel-border text-text-muted px-4 py-2.5 text-sm font-medium hover:border-text-muted transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className="flex-1 border border-red-500/50 text-red-400 px-4 py-2.5 text-sm font-medium hover:bg-red-500/10 transition-colors disabled:opacity-40"
          >
            {isLoading ? 'Clearing…' : `Redo ${stage.label}`}
          </button>
        </div>
      </div>
    </div>
  );
}
