# Vizia 0.3.0 Best Practices (March 2026 Standards)

## 🏛️ Core Philosophy
Vizia is a **retained-mode, reactive** GUI framework. Unlike Immediate Mode (egui), state is owned by **Models** and changes are propagated via **Lenses**. To maintain **120 FPS** in a DAW environment:
1.  **Minimize the Reactive Surface:** Bind views to the smallest possible sub-state.
2.  **Wait-Free UI Threads:** Never perform I/O or DSP on the main thread.
3.  **Pointer-Based Diffing:** Use `Arc` and pointer equality for complex state to skip deep equality checks.

---

## 🛠️ State Management (Lenses & Models)
- **Lens Composition:** Avoid accessing nested data via deep property chains. Compose lenses using `.then()` to allow Vizia to cache intermediate results.
  - *Bad:* `cx.data::<AppData>().project.metadata.name`
  - *Good:* `AppData::project.then(Project::metadata).then(Metadata::name)`
- **Data Trait:** Every type used in a Lens **MUST** implement `Data`.
  - For `Arc<T>`, implement `Data` using `Arc::ptr_eq(&self.0, &other.0)` for $O(1)$ diffing.
  - For small primitives, use standard `PartialEq`.
- **Event Batching:** If updating multiple fields, emit a single "Composite" event rather than multiple granular events to prevent redundant layout/draw passes.

---

## ⚡ Performance & Threading
- **ContextProxy:** The only thread-safe way to update the UI is via `cx.get_proxy()`.
- **cx.spawn():** Use for fire-and-forget async tasks. For the core DSP/Audio engine, use dedicated threads and a `ContextProxy` to emit telemetry back to the UI at 60Hz.
- **Morphorm Layout:** 
  - Prefer `Stretch(1.0)` for flexible layouts.
  - Use `Pixels()` for fixed-size controls (sliders, buttons).
  - Avoid `Percentage()` for complex nested layouts as it can cause rounding-error jitter.

---

## 🎹 Audio & DSP Specifics
- **Telemetry Buffering:** Do not emit an event for every single audio sample. Aggregate telemetry (Peak, RMS, FFT) on the DSP thread and emit a single update event every 16ms (60fps).
- **Lock-Free Rings:** Use `rtrb` or `crossbeam-channel` for command/telemetry flow between the Vizia UI and the `cpal` audio thread. **NEVER** use `std::sync::Mutex` in the audio callback.
- **Custom Views:** For high-density visualizations (Waveforms, Vectorscopes), override `draw()` in a custom View and use the `Canvas` API provided by Skia. Use path caching to prevent re-tessellation.

---

## 🚫 Anti-Slop Guidelines (Code & Logic)
- **No Verbosity:** Do not use "AI Slop" phrases like "Here is how to implement..." or "This approach ensures...". Provide the code and the technical rationale.
- **Technical Density:** Prioritize memory safety and performance. If a `Mutex` can be replaced by an `Atomic` or a `Cell`, do it.
- **Objectivity:** If a UI request contradicts DAW performance standards (e.g., "draw 1 million points per frame"), reject it and propose a decimated LOD (Level of Detail) approach.

---

## 📋 Example: Production Model Pattern
```rust
use vizia::prelude::*;
use std::sync::Arc;

#[derive(Lens)]
pub struct AppData {
    pub spectrum: Arc<Vec<f32>>, // Use Arc for pointer-diffing
    pub status: String,
}

impl Model for AppData {
    fn event(&mut self, cx: &mut EventContext, event: &mut Event) {
        event.map(|app_event, _| match app_event {
            AppEvent::UpdateSpectrum(data) => {
                self.spectrum = Arc::new(data); // New Arc triggers pointer diff
            }
            AppEvent::SetStatus(msg) => self.status = msg.clone(),
        });
    }
}

impl Data for AppData {
    fn same(&self, other: &Self) -> bool {
        self.status == other.status && Arc::ptr_eq(&self.spectrum, &other.spectrum)
    }
}
```
