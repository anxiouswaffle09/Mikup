# UI Components

## Core Components

- **`App.tsx`**: Root layout and primary state owner (the `payload` object).
- **`IngestionHeader.tsx`**: Triggers the Python pipeline via Tauri and handles status UI.
- **`WaveformVisualizer.tsx`**: Renders transcription segments and pacing Mikups. Use `wavesurfer.js` for audio visualization and timeline syncing.
- **`MetricsPanel.tsx`**: Displays spatial and impact metrics in a dashboard-style layout. Use CSS Grid for consistent layout across devices.
- **`DirectorChat.tsx`**: AI Director chat interface. Uses LLM APIs (Gemini/Claude) via the Tauri proxy.

## Development Checklist

1.  **Component Creation**: Use `PascalCase` filenames in `ui/src/components/`.
2.  **Linting**: Run `npm run lint` before committing changes.
3.  **Mock Mode**: In `App.tsx`, load `public/mikup_payload.json` by default for rapid UI iteration without needing the Python pipeline.
4.  **Styling**: Use Tailwind v4's CSS-first approach; avoid `tailwind.config.js`.
5.  **State Logic**: Pass the `payload` object down via props; avoid complex Redux stores unless state becomes unmanageable.

## UI Principles

- **Local-First Speed**: No cloud delays for UI interactions.
- **Micro-Visualization**: Every "Atomic Event" (Mikup) should be visually distinct on the timeline.
- **Data-Dense Layout**: Audio production requires dense, high-contrast metrics; prioritize readability and contrast.
