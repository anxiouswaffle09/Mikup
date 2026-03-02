# Best Practices: React 19 + Tailwind v4

Updated as of: March 2, 2026

## React 19 (Stable)
The paradigm has shifted to **Compiler-Driven Performance** and **Action-Based Data Flow**.

### Key Practices:
- **Zero Manual Memoization:** Manual `useMemo`, `useCallback`, and `React.memo` are deprecated. The React Compiler handles this automatically.
- **Actions API:** Use `useActionState` and `useFormStatus` for all async operations (Ingestion, Reports).
- **The `use` API:** 
  - Use `use(Promise)` to unwrap data directly in render.
  - Use `use(Context)` for conditional consumption of themes or audio routing.
- **Ref as a Prop:** `forwardRef` is deprecated. Pass `ref` directly as a prop.
- **Optimistic UI:** Use `useOptimistic` for "instant" feedback on mute/solo/playhead toggles.

## Tailwind CSS v4 (Oxide Engine)
### Key Practices:
- **CSS-First Configuration:** No `tailwind.config.js`. Use `@theme` variables in `index.css`.
- **Oxide Engine:** Leverage Rust-powered build speeds for microsecond HMR.
- **Container Queries:** Use native `@container` variants (e.g., `@md:flex-row`) for responsive DAW widgets.
- **Color Space:** Use `oklch()` for perceptually consistent diagnostic colors and full P3 gamut support.

## Diagnostic Visualization
- **Performance:** Use Canvas/WebGL via `requestAnimationFrame` for Vectorscopes and high-frequency Meters.
- **Data Flow:** Subscribe to Tauri events using `@tauri-apps/api/event` for real-time DSP telemetry.
- **Concurrent UI:** Use `useTransition` when switching between complex diagnostic views to maintain 60fps playhead animation.
