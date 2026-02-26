import { type ReactNode, useState } from 'react';
import { Activity, Radio, Cpu, HardDrive, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { parseMikupPayload, type MikupPayload } from '../types';

interface IngestionHeaderProps {
  metadata?: MikupPayload['metadata'];
  inputPath: string;
  onInputPathChange: (path: string) => void;
  onPayloadUpdate?: (payload: MikupPayload) => void;
}

function formatErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'Unknown processing error.';
}

export function IngestionHeader({
  metadata,
  inputPath,
  onInputPathChange,
  onPayloadUpdate,
}: IngestionHeaderProps) {
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleProcess = async () => {
    const requestedPath = inputPath.trim();
    if (!requestedPath) {
      setErrorMessage('Enter an input audio path before processing.');
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const result: string = await invoke('process_audio', { inputPath: requestedPath });
      const payload = parseMikupPayload(JSON.parse(result) as unknown);
      if (onPayloadUpdate) onPayloadUpdate(payload);
    } catch (error: unknown) {
      console.error(error);
      setErrorMessage(formatErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-panel p-5 rounded-2xl shrink-0 transition-all">
      <div className="flex flex-col lg:flex-row items-center justify-between gap-8">
        {/* Left Section: Branding */}
        <div className="flex items-center gap-8 shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 bg-accent/10 rounded-xl flex items-center justify-center text-accent">
              <Radio size={24} />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-textMain">Mikup</h1>
              <p className="text-[10px] text-textMuted uppercase tracking-widest font-medium">Audio Pipeline</p>
            </div>
          </div>

          <div className="h-8 w-px bg-panel-border mx-2 hidden lg:block" />

          <div className="flex gap-6 items-center">
            <StatusItem label="System" status="Online" colorClass="text-green-600" active icon={<Cpu size={14} />} />
            <StatusItem label="Engine" status="Ready" colorClass="text-accent" active icon={<Activity size={14} />} />
          </div>
        </div>

        {/* Middle Section: Input Area */}
        <div className="flex-1 max-w-2xl w-full">
          <div className="relative group">
            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-textMuted">
              <HardDrive size={16} />
            </div>
            <input
              type="text"
              value={inputPath}
              onChange={(event) => onInputPathChange(event.target.value)}
              className="w-full bg-background border border-panel-border group-hover:border-accent/30 rounded-xl py-3 pl-12 pr-32 text-sm transition-all focus:outline-none focus:border-accent focus:ring-4 focus:ring-accent/5"
              placeholder="Paste path to audio file..."
            />
            <div className="absolute inset-y-1.5 right-1.5 flex items-center">
              <button
                onClick={handleProcess}
                disabled={loading}
                className="h-full bg-accent hover:bg-accent/90 text-white px-6 rounded-lg text-xs font-bold transition-all flex items-center gap-2 disabled:opacity-50"
              >
                {loading ? <Loader2 className="animate-spin" size={14} /> : 'Process'}
              </button>
            </div>
          </div>
        </div>

        {/* Right Section: Session Pill */}
        {metadata?.source_file && (
          <div className="hidden xl:flex items-center gap-3 bg-accent/5 px-4 py-2 rounded-full border border-accent/10">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs font-medium text-accent truncate max-w-[120px]">
              {metadata.source_file.split('/').pop()}
            </span>
          </div>
        )}
      </div>

      {errorMessage && (
        <div className="mt-4 flex items-center gap-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
          {errorMessage}
        </div>
      )}
    </div>
  );
}

function StatusItem({ label, status, colorClass, active, icon }: { label: string; status: string; colorClass: string; active?: boolean, icon: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="text-textMuted">{icon}</div>
      <div className="flex flex-col">
        <p className="text-[10px] text-textMuted uppercase font-bold tracking-wider mb-0.5">{label}</p>
        <p className={`text-xs font-semibold leading-none ${active ? colorClass : 'text-textMuted/40'}`}>{status}</p>
      </div>
    </div>
  );
}
