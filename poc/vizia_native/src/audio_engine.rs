#[allow(unused_imports)]
use atomic_float::AtomicF32;
#[allow(unused_imports)]
use rtrb::RingBuffer;
#[allow(unused_imports)]
use rubato::{
    FixedAsync, Resampler, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
#[allow(unused_imports)]
use std::sync::atomic::Ordering;

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
}

pub struct AudioController {
    pub cmd_tx:       rtrb::Producer<AudioCmd>,
    pub telemetry_rx: rtrb::Consumer<Telemetry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_new_does_not_panic() {
        let bufs = PreAllocBuffers::new(1024, 2);
        assert_eq!(bufs.input[0].len(), 1024);
        assert_eq!(bufs.output[0].len(), 1024);
        assert_eq!(bufs.input.len(), 2);
    }
}
