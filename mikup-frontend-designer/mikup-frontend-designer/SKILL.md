---
name: mikup-frontend-designer
description: Expert guide for frontend designing and engineering on Project Mikup. Focused on React 19 (Compiler, Actions), Tailwind CSS v4 (Oxide Engine, CSS-first), and Tauri v2. Use this skill when building UI components, styling layouts, or bridging Rust/Python logic to the React frontend.
---

# Mikup Frontend Designer

## Overview

This skill enables rapid, standards-compliant frontend development for Project Mikup. It prioritizes modern React 19 patterns, Tailwind v4's CSS-first approach, and Tauri v2's local-first architecture.

## Workflow Decision Tree

1.  **Is it a new component?** → Follow **[UI Components](references/ui_components.md)** and use `PascalCase` filenames.
2.  **Is it a style change?** → Use **[Tailwind v4 Guide](references/tailwind_v4_guide.md)** (No `tailwind.config.js`).
3.  **Does it fetch data?** → Use **[React 19 Patterns](references/react_19_patterns.md)** (No `useMemo`, Use Actions API).
4.  **Does it interact with the backend?** → Use **[Tauri v2 Bridge](references/tauri_v2_bridge.md)** to invoke Rust/Python commands.

## Core Capabilities

### 1. Modern React 19 Architecture
- **React Compiler Enabled**: Zero manual memoization (`useMemo`, `useCallback`) unless profiling shows specific hot-spots.
- **Actions API**: Use `useActionState` and `useFormStatus` for ingestion forms and user inputs.
- **RSC Pattern**: Even in Tauri, use the Server Component pattern for heavy data-processing components to maintain responsiveness.

### 2. Tailwind CSS v4 (Oxide)
- **CSS-First Configuration**: All `@theme` variables live in `src/index.css`.
- **Performance First**: Prefer `gap` over `space-y-*` and direct CSS variables over `@apply`.
- **Modern Color Spaces**: Extensive use of `oklch()` for predictable, perceptual colors.

### 3. Tauri v2 Integration
- **Local-First Processing**: Triggers the Python DSP pipeline via Rust subprocesses.
- **Granular Permissions**: Uses `src-tauri/capabilities/default.json` for filesystem/audio access.
- **Mobile Support**: The UI is designed to be responsive for potential iOS/Android deployment via Tauri v2.

## Project Structure (UI)

- `ui/src/components/`: Core UI building blocks (`MetricsPanel.tsx`, `WaveformVisualizer.tsx`, etc.).
- `ui/src/App.tsx`: Main application entry and payload state owner.
- `ui/src/index.css`: Tailwind v4 configuration and global styles.
- `ui/public/`: Static assets and mock payloads (`mikup_payload.json`).

## References

- **[React 19 Patterns](references/react_19_patterns.md)**: Standardized React 19 practices.
- **[Tailwind v4 Guide](references/tailwind_v4_guide.md)**: Configuration and style best practices.
- **[Tauri v2 Bridge](references/tauri_v2_bridge.md)**: Interacting with the Python backend.
- **[UI Components](references/ui_components.md)**: Component-specific architectural details.
