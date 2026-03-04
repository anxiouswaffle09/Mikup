# Vizia Pipeline Wiring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the "New Project" button in the Vizia landing view to spawn the Python pipeline and auto-transition to Workspace on success.

**Architecture:** `AppEvent::StartPipeline(path)` spawns `python3 -m src.main --input <path> --output-dir <derived>` via `cx.spawn`; stdout JSON lines (`{"type":"progress","stage":…,"progress":0.0–1.0,"message":…}`) drive `AppData::pipeline_progress`/`pipeline_message`; on exit-0 the derived `mikup_payload.json` is loaded via the existing `AppEvent::LoadProject` path.

**Tech Stack:** Rust 1.86, Vizia 0.3, serde_json 1.0, std::process::Command, std::io::BufRead

---

### Task 1: Extend AppData with pipeline telemetry fields

**Files:**
- Modify: `native/src/models.rs:72-86` (AppData struct)
- Modify: `native/src/models.rs:88-98` (AppEvent enum)
- Modify: `native/src/models.rs:100-140` (apply_event / Model::event)
- Modify: `native/src/models.rs:244-257` (test helper make_appdata)

**Step 1: Add fields to AppData struct**

In `native/src/models.rs`, inside `pub struct AppData { … }`, after the `vectorscope_data` field add:

```rust
    pub pipeline_progress: f32,
    pub pipeline_message: String,
```

**Step 2: Add PipelineProgress event variant**

In `AppEvent`, after `SwitchView(ViewState)`:

```rust
    PipelineProgress(f32, String),
```

**Step 3: Handle PipelineProgress in apply_event**

In `apply_event`, after the `AppEvent::SwitchView(v)` arm:

```rust
            AppEvent::PipelineProgress(pct, msg) => {
                self.pipeline_progress = pct;
                self.pipeline_message = msg;
            }
```

Move `StartPipeline` out of `apply_event` entirely — replace the existing arm with a no-op comment (it will be intercepted upstream in `Model::event`):

```rust
            // Handled in Model::event (needs cx).
            AppEvent::LoadProject(_) | AppEvent::SelectNewAudioFile | AppEvent::StartPipeline(_) => {}
```

**Step 4: Update make_appdata() in tests**

Add the two new fields:

```rust
        pipeline_progress: 0.0,
        pipeline_message: String::new(),
```

**Step 5: Verify existing tests still compile and pass**

```bash
cd native && cargo test 2>&1 | tail -20
```
Expected: all 3 existing tests PASS, no new warnings about missing fields.

**Step 6: Commit**

```bash
git add native/src/models.rs
git commit -m "feat(native): add pipeline_progress/message to AppData + PipelineProgress event"
```

---

### Task 2: Implement StartPipeline in Model::event

**Files:**
- Modify: `native/src/models.rs:142-196` (Model::event impl)

**Step 1: Add StartPipeline arm to Model::event**

In `Model::event`, add a new match arm BEFORE `other => self.apply_event(other)`:

```rust
            AppEvent::StartPipeline(path) => {
                self.current_view = ViewState::Processing;
                self.pipeline_progress = 0.0;
                self.pipeline_message = "Starting…".to_string();

                cx.spawn(move |proxy| {
                    let stem = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("output")
                        .to_string();
                    let output_dir = path
                        .parent()
                        .unwrap_or_else(|| std::path::Path::new("."))
                        .join(format!("{}_mikup", stem));

                    // Project root is one level above this crate's manifest dir.
                    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .map(|p| p.to_path_buf())
                        .unwrap_or_else(|| std::path::PathBuf::from("."));

                    let mut child = match std::process::Command::new("python3")
                        .args([
                            "-m",
                            "src.main",
                            "--input",
                            path.to_str().unwrap_or(""),
                            "--output-dir",
                            output_dir.to_str().unwrap_or(""),
                        ])
                        .current_dir(&project_root)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::inherit())
                        .spawn()
                    {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[mikup] Failed to spawn python3: {e}");
                            proxy.emit(AppEvent::SwitchView(ViewState::Landing)).ok();
                            return;
                        }
                    };

                    if let Some(stdout) = child.stdout.take() {
                        use std::io::BufRead;
                        let reader = std::io::BufReader::new(stdout);
                        for line in reader.lines().map_while(Result::ok) {
                            if let Ok(val) =
                                serde_json::from_str::<serde_json::Value>(&line)
                            {
                                if val
                                    .get("type")
                                    .and_then(|t| t.as_str())
                                    == Some("progress")
                                {
                                    let progress = val
                                        .get("progress")
                                        .and_then(|p| p.as_f64())
                                        .unwrap_or(0.0) as f32;
                                    let message = val
                                        .get("message")
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    proxy
                                        .emit(AppEvent::PipelineProgress(progress, message))
                                        .ok();
                                }
                            }
                        }
                    }

                    match child.wait() {
                        Ok(s) if s.success() => {
                            proxy
                                .emit(AppEvent::LoadProject(
                                    output_dir.join("mikup_payload.json"),
                                ))
                                .ok();
                        }
                        Ok(s) => {
                            eprintln!(
                                "[mikup] Pipeline exited {}",
                                s.code().unwrap_or(-1)
                            );
                            proxy.emit(AppEvent::SwitchView(ViewState::Landing)).ok();
                        }
                        Err(e) => {
                            eprintln!("[mikup] Pipeline wait error: {e}");
                            proxy.emit(AppEvent::SwitchView(ViewState::Landing)).ok();
                        }
                    }
                });
            }
```

**Step 2: Build to verify no compile errors**

```bash
cd native && cargo build 2>&1 | grep -E "^error"
```
Expected: no output (clean build).

**Step 3: Commit**

```bash
git add native/src/models.rs
git commit -m "feat(native): implement StartPipeline — spawn python3 pipeline, stream JSON progress"
```

---

### Task 3: Upgrade the Processing view to show progress bar

**Files:**
- Modify: `native/src/main.rs:225-231` (Processing branch of Binding)

**Step 1: Replace the Processing view body**

Find the current Processing arm:

```rust
                    ViewState::Processing => {
                        VStack::new(cx, |cx| {
                            Label::new(cx, "Processing…").color(Color::rgb(180, 180, 200));
                        })
                        .width(Stretch(1.0))
                        .height(Stretch(1.0))
                        .background_color(Color::rgb(30, 30, 30));
                    }
```

Replace with:

```rust
                    ViewState::Processing => {
                        VStack::new(cx, |cx| {
                            Label::new(cx, "Processing…")
                                .color(Color::rgb(180, 180, 200));

                            Binding::new(cx, AppData::pipeline_message, |cx, msg_lens| {
                                Label::new(cx, msg_lens.get(cx).as_str())
                                    .color(Color::rgb(120, 120, 140))
                                    .top(Pixels(8.0));
                            });

                            // Progress track
                            VStack::new(cx, |cx| {
                                Binding::new(
                                    cx,
                                    AppData::pipeline_progress,
                                    |cx, pct_lens| {
                                        let pct = pct_lens.get(cx);
                                        Element::new(cx)
                                            .width(Percentage(pct * 100.0))
                                            .height(Stretch(1.0))
                                            .background_color(Color::rgb(100, 120, 220));
                                    },
                                );
                            })
                            .width(Pixels(400.0))
                            .height(Pixels(8.0))
                            .background_color(Color::rgb(50, 50, 65))
                            .top(Pixels(16.0));
                        })
                        .width(Stretch(1.0))
                        .height(Stretch(1.0))
                        .child_left(Stretch(1.0))
                        .child_right(Stretch(1.0))
                        .child_top(Stretch(1.0))
                        .child_bottom(Stretch(1.0))
                        .background_color(Color::rgb(30, 30, 30));
                    }
```

**Step 2: Add `pipeline_progress` and `pipeline_message` to AppData init in main()**

In the `AppData { … }.build(cx)` block (around line 158), add:

```rust
            pipeline_progress: 0.0,
            pipeline_message: String::new(),
```

**Step 3: Build clean**

```bash
cd native && cargo build 2>&1 | grep -E "^error"
```
Expected: no output.

**Step 4: Run cargo test to confirm nothing regressed**

```bash
cd native && cargo test 2>&1 | tail -10
```
Expected: 3 tests pass.

**Step 5: Commit**

```bash
git add native/src/main.rs
git commit -m "feat(native): Processing view — progress bar + stage message driven by AppData lenses"
```
