use std::path::PathBuf;

use atomic_float::AtomicF32;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::dsp::loudness::LoudnessAnalyzer;
use crate::dsp::spatial::SpatialAnalyzer;
use crate::dsp::{MikupAudioDecoder, shared_default_stem_states};

pub static VOLUME: AtomicF32 = AtomicF32::new(1.0);

#[derive(Debug, Clone)]
pub enum AudioCmd {
    Play,
    Pause,
    SetVolume(f32),
    Seek(u64),
    LoadProject {
        dx: PathBuf,
        mx: PathBuf,
        fx: PathBuf,
    },
}

/// 10ms at 48 kHz — short enough to be inaudible, long enough to suppress
/// discontinuity clicks on project switch.
const FADE_SAMPLES: usize = 480;

enum FadeState {
    Steady,
    FadingOut {
        remaining: usize,
        pending: (PathBuf, PathBuf, PathBuf),
    },
    FadingIn {
        remaining: usize,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct Telemetry {
    pub playhead_ms: u64,
    pub dx_lufs: f32,
    pub music_lufs: f32,
    pub effects_lufs: f32,
    pub dx_peak_dbtp: f32,
    pub music_peak_dbtp: f32,
    pub effects_peak_dbtp: f32,
    /// 256 X/Y pairs interleaved: [x0, y0, x1, y1, ...]. Mid-Side Lissajous.
    pub spatial_xy: [f32; 512],
    pub phase_correlation: f32,
    pub spatial_point_count: u16,
}

pub struct AudioController {
    pub cmd_tx: rtrb::Producer<AudioCmd>,
    pub telemetry_rx: rtrb::Consumer<Telemetry>,
    _stream: Option<cpal::Stream>,
}

const CHUNK_SIZE: usize = 2048;
const DSP_SAMPLE_RATE: u32 = 48_000;

impl AudioController {
    /// Spawn the DSP thread with real stem decoding via MikupAudioDecoder.
    pub fn new(
        hw_rate: f64,
        dx_path: impl AsRef<std::path::Path> + Send + 'static,
        music_path: impl AsRef<std::path::Path> + Send + 'static,
        effects_path: impl AsRef<std::path::Path> + Send + 'static,
    ) -> Self {
        use rtrb::RingBuffer;
        let (cmd_tx, cmd_rx) = RingBuffer::<AudioCmd>::new(32);
        let (telemetry_tx, telemetry_rx) = RingBuffer::<Telemetry>::new(128);
        let (audio_tx, mut audio_rx) = RingBuffer::<f32>::new(CHUNK_SIZE * 8);

        std::thread::Builder::new()
            .name("dsp-thread".into())
            .spawn(move || {
                dsp_thread_main(
                    hw_rate,
                    cmd_rx,
                    telemetry_tx,
                    audio_tx,
                    dx_path,
                    music_path,
                    effects_path,
                )
            })
            .expect("spawn dsp thread");

        // ── cpal output stream (optional — headless/CI graceful degradation) ──
        let _stream = try_build_audio_stream(audio_rx);

        AudioController {
            cmd_tx,
            telemetry_rx,
            _stream,
        }
    }
}

/// Attempt to open a cpal output stream. Returns `None` (silent mode) if no
/// audio device is available — logs a warning but does NOT panic.
fn try_build_audio_stream(mut audio_rx: rtrb::Consumer<f32>) -> Option<cpal::Stream> {
    let host = cpal::default_host();
    let device = host.default_output_device().or_else(|| {
        eprintln!("[mikup] WARNING: no audio output device — running in silent mode");
        None
    })?;
    let config = device.default_output_config().ok().or_else(|| {
        eprintln!("[mikup] WARNING: could not read output config — running in silent mode");
        None
    })?;
    let stream = device
        .build_output_stream(
            &config.into(),
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let vol = VOLUME.load(std::sync::atomic::Ordering::Relaxed);
                for sample in data.iter_mut() {
                    *sample = audio_rx.pop().unwrap_or(0.0) * vol;
                }
            },
            |err| eprintln!("cpal stream error: {err}"),
            None,
        )
        .ok()?;
    stream.play().ok()?;
    Some(stream)
}

fn dsp_thread_main(
    hw_rate: f64,
    mut cmd_rx: rtrb::Consumer<AudioCmd>,
    mut telemetry_tx: rtrb::Producer<Telemetry>,
    mut audio_tx: rtrb::Producer<f32>,
    dx_path: impl AsRef<std::path::Path>,
    music_path: impl AsRef<std::path::Path>,
    effects_path: impl AsRef<std::path::Path>,
) {
    use audioadapter_buffers::direct::SequentialSliceOfVecs;
    use rubato::{
        Async, FixedAsync, Resampler, SincInterpolationParameters, SincInterpolationType,
        WindowFunction,
    };
    use std::sync::atomic::Ordering;

    // Open the production stem decoder
    let mut decoder = match MikupAudioDecoder::new(
        dx_path,
        music_path,
        effects_path,
        None::<&std::path::Path>,
        shared_default_stem_states(),
        DSP_SAMPLE_RATE,
        CHUNK_SIZE,
    ) {
        Ok(d) => Some(d),
        Err(e) => {
            eprintln!("[mikup] Failed to open stems: {e}");
            None
        }
    };

    let mut loudness = LoudnessAnalyzer::new(DSP_SAMPLE_RATE).expect("create loudness analyzer");

    // ── Pre-allocate resampler ───────────────────────────────────────────
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let ratio = hw_rate / DSP_SAMPLE_RATE as f64;
    let mut resampler =
        Async::<f32>::new_sinc(ratio, 2.0, &params, CHUNK_SIZE, 2, FixedAsync::Input)
            .expect("build resampler");
    let out_max = resampler.output_frames_max();
    let mut resample_input = vec![vec![0.0_f32; CHUNK_SIZE]; 2];
    let mut resample_output = vec![vec![0.0_f32; out_max]; 2];

    let mut spatial = SpatialAnalyzer::new();
    let mut playing = false;
    let mut playhead_samples: u64 = 0;
    let mut finished = false;
    let mut fade_state = FadeState::Steady;

    // ── Process loop ─────────────────────────────────────────────────────
    loop {
        while let Ok(cmd) = cmd_rx.pop() {
            match cmd {
                AudioCmd::Play => playing = true,
                AudioCmd::Pause => playing = false,
                AudioCmd::SetVolume(v) => VOLUME.store(v, Ordering::Relaxed),
                AudioCmd::Seek(ms) => {
                    if let Some(ref mut dec) = decoder {
                        let secs = ms as f32 / 1000.0;
                        if let Err(e) = dec.seek(secs) {
                            eprintln!("[mikup] Seek error: {e}");
                        } else {
                            playhead_samples = ms * DSP_SAMPLE_RATE as u64 / 1000;
                            finished = false;
                            resampler.reset();
                        }
                    }
                }
                AudioCmd::LoadProject { dx, mx, fx } => {
                    if playing {
                        // Begin fade-out ramp; decoder swap happens when ramp
                        // reaches zero.  A second LoadProject during an active
                        // fade simply replaces the pending paths.
                        fade_state = FadeState::FadingOut {
                            remaining: FADE_SAMPLES,
                            pending: (dx, mx, fx),
                        };
                    } else {
                        // Not playing — no audible transition, swap immediately.
                        decoder = match MikupAudioDecoder::new(
                            dx,
                            mx,
                            fx,
                            None::<&std::path::Path>,
                            shared_default_stem_states(),
                            DSP_SAMPLE_RATE,
                            CHUNK_SIZE,
                        ) {
                            Ok(d) => Some(d),
                            Err(e) => {
                                eprintln!("[mikup] LoadProject: failed to open stems: {e}");
                                None
                            }
                        };
                        playhead_samples = 0;
                        finished = false;
                        resampler.reset();
                        loudness.reset();
                        fade_state = FadeState::Steady;
                    }
                }
            }
        }

        if !playing || finished {
            std::thread::sleep(std::time::Duration::from_millis(1));
            continue;
        }

        // Back-pressure
        if audio_tx.slots() < CHUNK_SIZE * 2 {
            std::hint::spin_loop();
            continue;
        }

        // Read a frame from the production decoder
        let frame = if let Some(ref mut dec) = decoder {
            match dec.read_frame() {
                Ok(Some(f)) => f,
                Ok(None) => {
                    finished = true;
                    continue;
                }
                Err(e) => {
                    eprintln!("[mikup] Decode error: {e}");
                    finished = true;
                    continue;
                }
            }
        } else {
            std::thread::sleep(std::time::Duration::from_millis(10));
            continue;
        };

        // EBU R128 loudness metering
        let lufs_metrics = loudness.process_frame(&frame).unwrap_or_default();

        // Spatial analysis → Lissajous points + phase correlation
        let spatial_metrics = spatial.process_frame(&frame);
        let mut spatial_xy = [0.0_f32; 512];
        let pts = spatial.lissajous_points();
        let n_out = pts.len().min(256);
        let stride = if pts.len() > 256 { pts.len() / 256 } else { 1 };
        for i in 0..n_out {
            let src = i * stride;
            spatial_xy[i * 2] = pts[src].x;
            spatial_xy[i * 2 + 1] = pts[src].y;
        }

        // Mix dialogue + background → mono → stereo for playback,
        // applying crossfade gain ramp when transitioning projects.
        let frame_len = frame.dialogue_raw.len();
        for i in 0..CHUNK_SIZE {
            let dx = if i < frame_len {
                frame.dialogue_raw[i]
            } else {
                0.0
            };
            let bg = if i < frame.background_raw.len() {
                frame.background_raw[i]
            } else {
                0.0
            };
            let mixed = dx + bg;

            let gain = match &mut fade_state {
                FadeState::Steady => 1.0,
                FadeState::FadingOut { remaining, .. } => {
                    if *remaining > 0 {
                        *remaining -= 1;
                        *remaining as f32 / FADE_SAMPLES as f32
                    } else {
                        0.0
                    }
                }
                FadeState::FadingIn { remaining } => {
                    if *remaining > 0 {
                        let r = *remaining as f32;
                        *remaining -= 1;
                        1.0 - r / FADE_SAMPLES as f32
                    } else {
                        1.0
                    }
                }
            };

            resample_input[0][i] = mixed * gain;
            resample_input[1][i] = mixed * gain;
        }

        // ── Fade state transitions ───────────────────────────────────────
        if let FadeState::FadingOut { remaining: 0, .. } = &fade_state {
            if let FadeState::FadingOut { pending: (dx, mx, fx), .. } =
                std::mem::replace(&mut fade_state, FadeState::Steady)
            {
                decoder = match MikupAudioDecoder::new(
                    dx,
                    mx,
                    fx,
                    None::<&std::path::Path>,
                    shared_default_stem_states(),
                    DSP_SAMPLE_RATE,
                    CHUNK_SIZE,
                ) {
                    Ok(d) => Some(d),
                    Err(e) => {
                        eprintln!("[mikup] LoadProject: failed to open stems: {e}");
                        None
                    }
                };
                playhead_samples = 0;
                finished = false;
                resampler.reset();
                loudness.reset();
                fade_state = FadeState::FadingIn {
                    remaining: FADE_SAMPLES,
                };
            }
        }
        if let FadeState::FadingIn { remaining: 0 } = &fade_state {
            fade_state = FadeState::Steady;
        }

        // Sinc resample → hardware rate
        let Ok((_, out_frames)) = ({
            let input = SequentialSliceOfVecs::new(&resample_input, 2, CHUNK_SIZE).unwrap();
            let mut output =
                SequentialSliceOfVecs::new_mut(&mut resample_output, 2, out_max).unwrap();
            resampler.process_into_buffer(&input, &mut output, None)
        }) else {
            continue;
        };

        for idx in 0..out_frames {
            for ch in 0..2 {
                let _ = audio_tx.push(resample_output[ch][idx]);
            }
        }

        playhead_samples += frame_len as u64;
        let playhead_ms = playhead_samples * 1000 / DSP_SAMPLE_RATE as u64;

        let _ = telemetry_tx.push(Telemetry {
            playhead_ms,
            dx_lufs: lufs_metrics.dialogue.momentary_lufs,
            music_lufs: lufs_metrics.music.momentary_lufs,
            effects_lufs: lufs_metrics.effects.momentary_lufs,
            dx_peak_dbtp: lufs_metrics.dialogue.true_peak_dbtp,
            music_peak_dbtp: lufs_metrics.music.true_peak_dbtp,
            effects_peak_dbtp: lufs_metrics.effects.true_peak_dbtp,
            spatial_xy,
            phase_correlation: spatial_metrics.phase_correlation,
            spatial_point_count: n_out as u16,
        });
    }
}

pub fn detect_hw_rate() -> f64 {
    use cpal::traits::{DeviceTrait, HostTrait};
    cpal::default_host()
        .default_output_device()
        .and_then(|d| d.default_output_config().ok())
        .map(|c| c.sample_rate() as f64)
        .unwrap_or(48_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_stream_does_not_panic_when_called() {
        use rtrb::RingBuffer;
        let (_, rx) = RingBuffer::<f32>::new(CHUNK_SIZE * 8);
        // Must not panic regardless of audio device availability (headless/CI)
        let _stream: Option<cpal::Stream> = try_build_audio_stream(rx);
    }

    #[test]
    fn audio_callback_captures_are_send() {
        use rtrb::RingBuffer;
        fn assert_send<T: Send + 'static>(_: T) {}
        let (_, mut consumer) = RingBuffer::<f32>::new(64);
        let cb = move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            let vol = VOLUME.load(std::sync::atomic::Ordering::Relaxed);
            for sample in data.iter_mut() {
                *sample = consumer.pop().unwrap_or(0.0) * vol;
            }
        };
        assert_send(cb);
    }

    #[test]
    fn resampler_process_into_buffer_zero_alloc() {
        use audioadapter_buffers::direct::SequentialSliceOfVecs;
        use rubato::{
            Async, FixedAsync, Resampler, SincInterpolationParameters, SincInterpolationType,
            WindowFunction,
        };
        let params = SincInterpolationParameters {
            sinc_len: 64,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };
        let chunk = 512_usize;
        let ratio = 48000.0 / 44100.0_f64;
        let mut resampler =
            Async::<f32>::new_sinc(ratio, 2.0, &params, chunk, 2, FixedAsync::Input).unwrap();

        let out_max = resampler.output_frames_max();
        let mut input_data: Vec<Vec<f32>> = vec![vec![0.0_f32; chunk]; 2];
        let mut output_data: Vec<Vec<f32>> = vec![vec![0.0_f32; out_max]; 2];

        for ch in &mut input_data {
            for (i, s) in ch.iter_mut().enumerate() {
                *s = (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 44100.0).sin();
            }
        }

        let input = SequentialSliceOfVecs::new(&input_data, 2, chunk).unwrap();
        let mut output = SequentialSliceOfVecs::new_mut(&mut output_data, 2, out_max).unwrap();

        let (_, out_frames) = resampler
            .process_into_buffer(&input, &mut output, None)
            .unwrap();

        assert!(out_frames > 0, "resampler produced no output");
        assert_eq!(output_data.len(), 2);
    }
}
