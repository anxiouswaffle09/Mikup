import React, { useState, useEffect } from 'react';
import { WaveformVisualizer } from './components/WaveformVisualizer';
import { MetricsPanel } from './components/MetricsPanel';
import { DirectorChat } from './components/DirectorChat';
import { IngestionHeader } from './components/IngestionHeader';

function App() {
  const [payload, setPayload] = useState<any>(null);

  // Load the mock payload for preview initially
  useEffect(() => {
    fetch('/mikup_payload.json')
      .then(res => res.json())
      .then(data => setPayload(data))
      .catch(err => console.error("Could not load payload", err));
  }, []);

  return (
    <div className="min-h-screen flex flex-col p-4 gap-4">
      <IngestionHeader metadata={payload?.metadata} onPayloadUpdate={setPayload} />
      
      <div className="flex-1 grid grid-cols-12 gap-4 overflow-hidden">
        {/* Main Content Area */}
        <div className="col-span-8 flex flex-col gap-4">
          <div className="panel p-4 h-64">
            <h2 className="text-sm font-bold text-textMuted uppercase mb-4">Timeline & Pacing</h2>
            <WaveformVisualizer 
              transcription={payload?.transcription} 
              pacing={payload?.metrics?.pacing_mikups} 
              duration={payload?.metrics?.spatial_metrics?.total_duration}
            />
          </div>
          
          <div className="panel p-4 flex-1">
            <h2 className="text-sm font-bold text-textMuted uppercase mb-4">Mix Dynamics</h2>
            <MetricsPanel metrics={payload?.metrics} semantics={payload?.semantics} />
          </div>
        </div>

        {/* Sidebar: AI Director */}
        <div className="col-span-4 flex flex-col gap-4">
          <div className="panel p-4 flex-1 flex flex-col">
            <h2 className="text-sm font-bold text-textMuted uppercase mb-4">AI Director</h2>
            <DirectorChat payload={payload} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
