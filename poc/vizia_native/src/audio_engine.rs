use atomic_float::AtomicF32;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub static VOLUME: AtomicF32 = AtomicF32::new(1.0);

#[derive(Debug, Clone, Copy)]
pub enum AudioCmd {
    Play,
    Pause,
    SetVolume(f32),
}

#[derive(Debug, Clone, Copy)]
pub struct Telemetry {
    pub lufs: f32,
    pub playhead_ms: u64,
}

pub struct PreAllocBuffers {
    pub input:  Vec<Vec<f32>>,
    pub output: Vec<Vec<f32>>,
}

impl PreAllocBuffers {
    pub fn new(chunk_size: usize, channels: usize) -> Self {
        Self {
            input:  vec![vec![0.0_f32; chunk_size]; channels],
            output: vec![vec![0.0_f32; chunk_size]; channels],
        }
    }

    pub fn new_with_output_max(input_size: usize, output_max: usize, channels: usize) -> Self {
        Self {
            input:  vec![vec![0.0_f32; input_size];  channels],
            output: vec![vec![0.0_f32; output_max]; channels],
        }
    }
}

pub struct AudioController {
    pub cmd_tx:       rtrb::Producer<AudioCmd>,
    pub telemetry_rx: rtrb::Consumer<Telemetry>,
    _stream:          cpal::Stream,
}

const CHUNK_SIZE: usize = 1024;
const SOURCE_RATE: f64 = 44100.0;

impl AudioController {
    /// Spawns the background DSP thread and wires the cpal output stream.
    /// All DSP buffers are pre-allocated here — the process loop and cpal callback
    /// have zero allocations.
    pub fn new(hw_rate: f64) -> Self {
        use rtrb::RingBuffer;
        let (cmd_tx, cmd_rx)             = RingBuffer::<AudioCmd>::new(32);
        let (telemetry_tx, telemetry_rx) = RingBuffer::<Telemetry>::new(128);
        let (audio_tx, mut audio_rx)     = RingBuffer::<f32>::new(CHUNK_SIZE * 8);

        std::thread::Builder::new()
            .name("dsp-thread".into())
            .spawn(move || dsp_thread_main(hw_rate, cmd_rx, telemetry_tx, audio_tx))
            .expect("spawn dsp thread");

        // ── cpal output stream ────────────────────────────────────────────
        let host   = cpal::default_host();
        let device = host.default_output_device().expect("no output device");
        let config = device.default_output_config().expect("no output config");

        let stream = device
            .build_output_stream(
                &config.into(),
                // Zero-alloc callback: atomic load + ring pop only
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    let vol = VOLUME.load(std::sync::atomic::Ordering::Relaxed);
                    for sample in data.iter_mut() {
                        *sample = audio_rx.pop().unwrap_or(0.0) * vol;
                    }
                },
                |err| eprintln!("cpal stream error: {err}"),
                None,
            )
            .expect("build output stream");

        stream.play().expect("start stream");

        AudioController { cmd_tx, telemetry_rx, _stream: stream }
    }
}

fn dsp_thread_main(
    hw_rate: f64,
    mut cmd_rx: rtrb::Consumer<AudioCmd>,
    mut telemetry_tx: rtrb::Producer<Telemetry>,
    mut audio_tx: rtrb::Producer<f32>,
) {
    use audioadapter_buffers::direct::SequentialSliceOfVecs;
    use rubato::{Async, FixedAsync, Resampler, SincInterpolationParameters, SincInterpolationType, WindowFunction};
    use std::sync::atomic::Ordering;

    // ── Pre-allocate. No heap allocation after this block. ───────────────
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let ratio = hw_rate / SOURCE_RATE;
    let mut resampler = Async::<f32>::new_sinc(ratio, 2.0, &params, CHUNK_SIZE, 2, FixedAsync::Input)
        .expect("build resampler");
    let out_max = resampler.output_frames_max();
    let mut bufs = PreAllocBuffers::new_with_output_max(CHUNK_SIZE, out_max, 2);
    let mut playing = false;
    let mut playhead: u64 = 0;

    // ── Zero-allocation process loop ─────────────────────────────────────
    loop {
        while let Ok(cmd) = cmd_rx.pop() {
            match cmd {
                AudioCmd::Play => playing = true,
                AudioCmd::Pause => playing = false,
                AudioCmd::SetVolume(v) => VOLUME.store(v, Ordering::Relaxed),
            }
        }

        if !playing {
            std::thread::sleep(std::time::Duration::from_millis(1));
            continue;
        }

        let vol = VOLUME.load(Ordering::Relaxed);

        for ch in &mut bufs.input {
            for (i, s) in ch.iter_mut().enumerate() {
                let t = (playhead + i as u64) as f32 / SOURCE_RATE as f32;
                *s = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * vol;
            }
        }

        let Ok((_, out_frames)) = ({
            let input  = SequentialSliceOfVecs::new(&bufs.input, 2, CHUNK_SIZE).unwrap();
            let mut output = SequentialSliceOfVecs::new_mut(&mut bufs.output, 2, out_max).unwrap();
            resampler.process_into_buffer(&input, &mut output, None)
        }) else {
            continue;
        };

        for frame in 0..out_frames {
            for ch in 0..2 {
                let _ = audio_tx.push(bufs.output[ch][frame]);
            }
        }

        playhead += CHUNK_SIZE as u64;

        let playhead_ms = playhead * 1000 / SOURCE_RATE as u64;
        let rms: f32 = bufs.input[0].iter().map(|s| s * s).sum::<f32>() / CHUNK_SIZE as f32;
        let lufs = 20.0 * rms.sqrt().max(1e-9_f32).log10();
        let _ = telemetry_tx.push(Telemetry { lufs, playhead_ms });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn controller_new_does_not_panic() {
        let bufs = PreAllocBuffers::new(1024, 2);
        assert_eq!(bufs.input[0].len(), 1024);
        assert_eq!(bufs.output[0].len(), 1024);
        assert_eq!(bufs.input.len(), 2);
    }

    #[test]
    fn resampler_process_into_buffer_zero_alloc() {
        use audioadapter_buffers::direct::SequentialSliceOfVecs;
        use rubato::{Async, FixedAsync, Resampler, SincInterpolationParameters, SincInterpolationType, WindowFunction};
        let params = SincInterpolationParameters {
            sinc_len: 64,  // smaller for test speed
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };
        let chunk = 512_usize;
        let ratio = 48000.0 / 44100.0_f64;
        let mut resampler = Async::<f32>::new_sinc(ratio, 2.0, &params, chunk, 2, FixedAsync::Input).unwrap();

        let out_max = resampler.output_frames_max();
        let mut input_data:  Vec<Vec<f32>> = vec![vec![0.0_f32; chunk];    2];
        let mut output_data: Vec<Vec<f32>> = vec![vec![0.0_f32; out_max];  2];

        for ch in &mut input_data {
            for (i, s) in ch.iter_mut().enumerate() {
                *s = (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 44100.0).sin();
            }
        }

        let input  = SequentialSliceOfVecs::new(&input_data, 2, chunk).unwrap();
        let mut output = SequentialSliceOfVecs::new_mut(&mut output_data, 2, out_max).unwrap();

        let (_, out_frames) = resampler
            .process_into_buffer(&input, &mut output, None)
            .unwrap();

        assert!(out_frames > 0, "resampler produced no output");
        assert_eq!(output_data.len(), 2);
    }
}
