import { useState, useEffect } from 'react';
import { Radio } from 'lucide-react';
import { WaveformVisualizer } from './components/WaveformVisualizer';
import { MetricsPanel } from './components/MetricsPanel';
import { DirectorChat } from './components/DirectorChat';
import { IngestionHeader } from './components/IngestionHeader';
import { parseMikupPayload, resolveStemAudioSources, type MikupPayload } from './types';

function App() {
  const [payload, setPayload] = useState<MikupPayload | null>(null);
  const [payloadLoadError, setPayloadLoadError] = useState<string | null>(null);
  const [inputPath, setInputPath] = useState('');

  // Load the mock payload for preview initially
  useEffect(() => {
    let isCancelled = false;

    const loadInitialPayload = async () => {
      try {
        const response = await fetch('/mikup_payload.json');
        if (!response.ok) {
          throw new Error(`Preview payload load failed (${response.status})`);
        }
        const rawPayload: unknown = await response.json();
        const parsedPayload = parseMikupPayload(rawPayload);
        if (isCancelled) return;
        setPayload(parsedPayload);
        setPayloadLoadError(null);
        setInputPath(prev => prev || parsedPayload.metadata?.source_file || '');
      } catch (error: unknown) {
        if (isCancelled) return;
        setPayloadLoadError(
          error instanceof Error
            ? error.message
            : 'Unable to load preview payload JSON.',
        );
      }
    };

    loadInitialPayload();
    return () => {
      isCancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen flex flex-col p-8 gap-8 bg-background text-textMain selection:bg-accent/10 relative">
      <IngestionHeader
        metadata={payload?.metadata}
        inputPath={inputPath}
        onInputPathChange={setInputPath}
        onPayloadUpdate={(nextPayload) => {
          setPayload(nextPayload);
          setPayloadLoadError(null);
          setInputPath((prev) => nextPayload.metadata?.source_file ?? prev);
        }}
      />

      {payloadLoadError ? (
        <div className="bg-red-50 border border-red-100 p-4 rounded-2xl animate-in fade-in slide-in-from-top-2 duration-300 flex items-center gap-4">
          <div className="w-10 h-10 bg-red-100 text-red-600 rounded-xl flex items-center justify-center">
            <Radio size={20} className="rotate-45" />
          </div>
          <div>
            <p className="text-sm font-bold text-red-700">Payload Sync Failure</p>
            <p className="text-xs text-red-600/70 mt-0.5">{payloadLoadError}</p>
          </div>
        </div>
      ) : null}
      
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 min-h-0">
        {/* Main Content Area */}
        <div className="lg:col-span-8 flex flex-col gap-8 min-w-0">
          {/* Timeline Section */}
          <section className="panel p-8 h-[420px] flex flex-col relative transition-all hover:shadow-xl hover:shadow-black/5">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-xs font-bold text-textMuted uppercase tracking-widest flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-accent/40" />
                Pacing & Timeline
              </h2>
              <div className="text-[10px] text-textMuted font-mono bg-background px-3 py-1 rounded-full border border-panel-border">
                {payload?.metrics?.pacing_mikups?.length ?? 0} MIKUPS DETECTED
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
          
          {/* Metrics Section */}
          <section className="panel p-8 flex-1 min-h-[400px] flex flex-col transition-all hover:shadow-xl hover:shadow-black/5">
            <h2 className="text-xs font-bold text-textMuted uppercase tracking-widest mb-10 flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full bg-accent/40" />
              Structural Dynamics
            </h2>
            <div className="flex-1">
              <MetricsPanel metrics={payload?.metrics} semantics={payload?.semantics} />
            </div>
          </section>
        </div>

        {/* Sidebar: AI Director */}
        <aside className="lg:col-span-4 flex flex-col min-w-0">
          <div className="panel p-8 flex-1 flex flex-col min-h-[600px] lg:min-h-0 relative transition-all hover:shadow-xl hover:shadow-black/5">
            <h2 className="text-xs font-bold text-textMuted uppercase tracking-widest mb-8 flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full bg-accent/40" />
              AI Director
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
