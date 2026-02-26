import React, { useState } from 'react';
import { Activity, Radio, Cpu, HardDrive, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

export function IngestionHeader({ metadata, onPayloadUpdate }: { metadata?: any, onPayloadUpdate?: (payload: any) => void }) {
  const [loading, setLoading] = useState(false);

  const handleProcess = async () => {
    setLoading(true);
    try {
      // In a real Tauri app, we'd open a file picker first
      // For this demo, we'll process the test file
      const result: string = await invoke('process_audio', { inputPath: 'data/raw/test.wav' });
      const payload = JSON.parse(result);
      if (onPayloadUpdate) onPayloadUpdate(payload);
      alert("Pipeline complete!");
    } catch (err) {
      console.error(err);
      alert("Error: " + err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex justify-between items-center bg-panel border border-white/5 p-3 rounded-lg">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-accent/20 rounded-md flex items-center justify-center text-accent">
            <Radio size={20} />
          </div>
          <div>
            <h1 className="text-sm font-bold leading-tight">Project Mikup</h1>
            <p className="text-[10px] text-textMuted uppercase tracking-tighter">Audio Architecture Deconstructor</p>
          </div>
        </div>
        
        <div className="h-8 w-px bg-white/5 mx-2" />
        
        <div className="flex gap-6">
          <StatusItem label="Ingestion" status="Online" icon={<HardDrive size={12} />} />
          <StatusItem label="DSP Engine" status="Ready" icon={<Cpu size={12} />} />
          <StatusItem label="AI Director" status="Awaiting" icon={<Activity size={12} />} />
        </div>
      </div>

      <div className="flex gap-2">
        <div className="text-right mr-4">
          <p className="text-[10px] text-textMuted uppercase">Active Payload</p>
          <p className="text-xs font-mono">{metadata?.source_file || 'No file selected'}</p>
        </div>
        <button 
          onClick={handleProcess}
          disabled={loading}
          className="bg-accent hover:bg-accent/80 px-4 py-2 rounded-md text-xs font-bold transition-colors flex items-center gap-2"
        >
          {loading ? <Loader2 className="animate-spin" size={14} /> : 'PROCESS NEW FILE'}
        </button>
      </div>
    </div>
  );
}

function StatusItem({ label, status, icon }: { label: string, status: string, icon: any }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-textMuted">{icon}</div>
      <div>
        <p className="text-[10px] text-textMuted uppercase">{label}</p>
        <p className="text-[10px] font-bold text-green-400">{status}</p>
      </div>
    </div>
  );
}
