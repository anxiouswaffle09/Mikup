import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface StemConfig {
  id: string;
  label: string;
  color: string;
  glow: string;
}

const STEMS: StemConfig[] = [
  {
    id: "dx",
    label: "DX",
    color: "oklch(0.72 0.14 155)",
    glow: "0 0 8px rgba(80,200,130,0.7)",
  },
  {
    id: "music",
    label: "Music",
    color: "oklch(0.70 0.10 290)",
    glow: "0 0 8px rgba(150,110,230,0.7)",
  },
  {
    id: "effects",
    label: "Effects",
    color: "oklch(0.75 0.16 65)",
    glow: "0 0 8px rgba(230,170,40,0.7)",
  },
];

interface StemState {
  isSolo: boolean;
  isMuted: boolean;
}

type StemStates = Record<string, StemState>;

const MUTED_COLOR = "oklch(0.6 0.2 25)";

export function StemControlStrip() {
  const [stemStates, setStemStates] = useState<StemStates>(
    Object.fromEntries(STEMS.map((s) => [s.id, { isSolo: false, isMuted: false }]))
  );

  const handleToggle = async (stemId: string, field: "isSolo" | "isMuted") => {
    let next: StemState | undefined;
    setStemStates((prev) => {
      const current = prev[stemId];
      next = { ...current, [field]: !current[field] };
      return { ...prev, [stemId]: next };
    });
    if (!next) return;
    try {
      await invoke("set_stem_state", {
        stemId,
        isSolo: next.isSolo,
        isMuted: next.isMuted,
      });
    } catch {
      // Revert on error
      setStemStates((prev) => {
        const reverted = { ...prev[stemId], [field]: !prev[stemId][field] };
        return { ...prev, [stemId]: reverted };
      });
    }
  };

  return (
    <div className="flex items-center gap-3 px-1 py-2">
      <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted mr-2">
        Stems
      </span>
      {STEMS.map((stem) => {
        const state = stemStates[stem.id];
        const isMuted = state.isMuted;
        const isSolo = state.isSolo;

        return (
          <div
            key={stem.id}
            className="flex items-center gap-1 border border-panel-border rounded px-1.5 py-0.5 transition-all"
            style={{
              opacity: isMuted ? 0.4 : 1,
              boxShadow: isSolo ? stem.glow : "none",
              borderColor: isSolo ? stem.color : undefined,
            }}
          >
            <span
              className="text-[9px] font-bold mr-1 select-none"
              style={{ color: stem.color }}
            >
              {stem.label}
            </span>

            {/* Solo button */}
            <button
              onClick={() => handleToggle(stem.id, "isSolo")}
              className="w-5 h-5 text-[9px] font-black border transition-colors rounded-sm flex items-center justify-center"
              style={
                isSolo
                  ? { borderColor: stem.color, color: stem.color }
                  : { borderColor: "var(--color-panel-border)", color: "var(--color-text-muted)" }
              }
              title={`Solo ${stem.label}`}
            >
              S
            </button>

            {/* Mute button */}
            <button
              onClick={() => handleToggle(stem.id, "isMuted")}
              className="w-5 h-5 text-[9px] font-black border transition-colors rounded-sm flex items-center justify-center"
              style={
                isMuted
                  ? { borderColor: MUTED_COLOR, color: MUTED_COLOR }
                  : { borderColor: "var(--color-panel-border)", color: "var(--color-text-muted)" }
              }
              title={`Mute ${stem.label}`}
            >
              M
            </button>
          </div>
        );
      })}
    </div>
  );
}
