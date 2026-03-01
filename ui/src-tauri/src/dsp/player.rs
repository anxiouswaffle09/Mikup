use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use crossbeam_queue::ArrayQueue;

const BACKPRESSURE_SLEEP: Duration = Duration::from_millis(1);

pub struct AudioOutputPlayer {
    queue: Arc<ArrayQueue<f32>>,
    stream: cpal::Stream,
    hardware_sample_rate: u32,
    channels: usize,
    capacity: usize,
    producer_finished: Arc<AtomicBool>,
    drained: Arc<AtomicBool>,
    underrun_samples: Arc<AtomicU64>,
}

impl AudioOutputPlayer {
    pub fn new_default(buffer_seconds: f32) -> Result<Self, String> {
        if buffer_seconds <= 0.0 {
            return Err("buffer_seconds must be positive".to_string());
        }

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "No default output audio device found".to_string())?;

        let supported = device
            .default_output_config()
            .map_err(|e| format!("Failed to query default output config: {e}"))?;
        let sample_format = supported.sample_format();
        let hardware_sample_rate = supported.sample_rate();
        let config = supported.config();

        let channels = config.channels as usize;
        if channels == 0 {
            return Err("Default output stream reported zero channels".to_string());
        }

        let capacity = ((hardware_sample_rate as f32 * channels as f32 * buffer_seconds).ceil()
            as usize)
            .max(channels * 512);

        let queue = Arc::new(ArrayQueue::new(capacity));
        let producer_finished = Arc::new(AtomicBool::new(false));
        let drained = Arc::new(AtomicBool::new(false));
        let underrun_samples = Arc::new(AtomicU64::new(0));

        let stream = match sample_format {
            SampleFormat::F32 => Self::build_stream::<f32>(
                &device,
                &config,
                Arc::clone(&queue),
                Arc::clone(&producer_finished),
                Arc::clone(&drained),
                Arc::clone(&underrun_samples),
            ),
            SampleFormat::I16 => Self::build_stream::<i16>(
                &device,
                &config,
                Arc::clone(&queue),
                Arc::clone(&producer_finished),
                Arc::clone(&drained),
                Arc::clone(&underrun_samples),
            ),
            SampleFormat::U16 => Self::build_stream::<u16>(
                &device,
                &config,
                Arc::clone(&queue),
                Arc::clone(&producer_finished),
                Arc::clone(&drained),
                Arc::clone(&underrun_samples),
            ),
            other => Err(format!("Unsupported output sample format: {other:?}")),
        }?;

        Ok(Self {
            queue,
            stream,
            hardware_sample_rate,
            channels,
            capacity,
            producer_finished,
            drained,
            underrun_samples,
        })
    }

    fn build_stream<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        queue: Arc<ArrayQueue<f32>>,
        producer_finished: Arc<AtomicBool>,
        drained: Arc<AtomicBool>,
        underrun_samples: Arc<AtomicU64>,
    ) -> Result<cpal::Stream, String>
    where
        T: SizedSample + Sample + FromSample<f32>,
    {
        let error_callback = |err: cpal::StreamError| {
            eprintln!("Audio output stream error: {err}");
        };

        device
            .build_output_stream(
                config,
                move |data: &mut [T], _info: &cpal::OutputCallbackInfo| {
                    for sample in data.iter_mut() {
                        let value = queue.pop().unwrap_or_else(|| {
                            underrun_samples.fetch_add(1, Ordering::Relaxed);
                            0.0
                        });
                        *sample = T::from_sample(value);
                    }

                    if producer_finished.load(Ordering::Relaxed) && queue.is_empty() {
                        drained.store(true, Ordering::Relaxed);
                    }
                },
                error_callback,
                None,
            )
            .map_err(|e| format!("Failed to build output stream: {e}"))
    }

    pub fn hardware_sample_rate(&self) -> u32 {
        self.hardware_sample_rate
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn free_slots(&self) -> usize {
        self.capacity.saturating_sub(self.queue.len())
    }

    pub fn start(&self) -> Result<(), String> {
        self.stream
            .play()
            .map_err(|e| format!("Failed to start output stream: {e}"))
    }

    /// Non-blocking push: drops samples when the queue is full rather than stalling
    /// the DSP thread. Acceptable for the combined telemetry+audio use case where
    /// backpressure under heavy load is preferable to blocking analysis.
    pub fn push_interleaved_nonblocking(&self, interleaved_samples: &[f32]) {
        for &sample in interleaved_samples {
            let _ = self.queue.push(sample); // ignore Err (full queue) → sample dropped
        }
    }

    pub fn push_interleaved_blocking(
        &self,
        interleaved_samples: &[f32],
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        for mut sample in interleaved_samples.iter().copied() {
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(());
                }
                match self.queue.push(sample) {
                    Ok(()) => break,
                    Err(returned) => {
                        sample = returned;
                        std::thread::sleep(BACKPRESSURE_SLEEP);
                    }
                }
            }
        }

        Ok(())
    }

    pub fn mark_producer_finished(&self) {
        self.producer_finished.store(true, Ordering::Relaxed);
        if self.queue.is_empty() {
            self.drained.store(true, Ordering::Relaxed);
        }
    }

    pub fn wait_until_drained_or_cancel(&self, cancel: &AtomicBool, poll_interval: Duration) {
        while !cancel.load(Ordering::Relaxed) && !self.drained.load(Ordering::Relaxed) {
            std::thread::sleep(poll_interval);
        }
    }

    #[allow(dead_code)]
    pub fn underrun_samples(&self) -> u64 {
        self.underrun_samples.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Clone)]
pub struct MonoResampler {
    passthrough: bool,
    step: f64,
    position: f64,
    source: Vec<f32>,
}

impl MonoResampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Result<Self, String> {
        if input_rate == 0 || output_rate == 0 {
            return Err("sample rates must be > 0".to_string());
        }
        Ok(Self {
            passthrough: input_rate == output_rate,
            step: input_rate as f64 / output_rate as f64,
            position: 0.0,
            source: Vec::new(),
        })
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if input.is_empty() {
            return Vec::new();
        }

        if self.passthrough {
            return input.to_vec();
        }

        self.source.extend_from_slice(input);
        if self.source.len() < 2 {
            return Vec::new();
        }

        let mut output = Vec::new();
        while self.position + 1.0 < self.source.len() as f64 {
            let base = self.position.floor() as usize;
            let frac = self.position - base as f64;
            let current = self.source[base];
            let next = self.source[base + 1];
            output.push((current * (1.0 - frac as f32)) + (next * frac as f32));
            self.position += self.step;
        }

        let consumed = self.position.floor() as usize;
        if consumed > 0 {
            self.source.drain(0..consumed);
            self.position -= consumed as f64;
        }

        output
    }
}

pub fn interleave_mono(input: &[f32], channels: usize) -> Vec<f32> {
    if input.is_empty() || channels == 0 {
        return Vec::new();
    }

    let mut interleaved = Vec::with_capacity(input.len() * channels);
    for sample in input {
        for _ in 0..channels {
            interleaved.push(*sample);
        }
    }
    interleaved
}
