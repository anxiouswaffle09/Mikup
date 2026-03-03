use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::dsp::{self, AudioDecodeError};
use crate::models::ProjectMetadata;

#[derive(Debug, Deserialize)]
pub struct MikupPayload {
    pub metadata: PayloadMetadata,
    #[serde(default)]
    pub transcription: Transcription,
    #[serde(default)]
    pub metrics: Metrics,
    #[serde(default)]
    pub semantics: Semantics,
    #[serde(default)]
    pub artifacts: Artifacts,
}

#[derive(Debug, Deserialize)]
pub struct PayloadMetadata {
    pub source_file: String,
    pub pipeline_version: String,
    pub timestamp: String,
}

#[derive(Debug, Deserialize)]
struct PartialPayload {
    metadata: PayloadMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub default_projects_dir: PathBuf,
}

#[derive(Debug, Default, Deserialize)]
pub struct Transcription {
    #[serde(default)]
    pub segments: Vec<TranscriptSegment>,
    #[serde(default)]
    pub word_segments: Vec<WordSegment>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TranscriptSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub speaker: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WordSegment {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Default, Deserialize)]
pub struct Metrics {
    #[serde(default)]
    pub pacing_mikups: Vec<PacingMikup>,
    #[serde(default)]
    pub lufs_graph: Option<LufsGraph>,
    #[serde(default)]
    pub diagnostic_meters: Option<DiagnosticMeters>,
}

#[derive(Debug, Deserialize)]
pub struct PacingMikup {
    pub timestamp: f64,
    pub duration_ms: u64,
    #[serde(default)]
    pub context: String,
}

#[derive(Debug, Deserialize)]
pub struct LufsGraph {
    #[serde(default)]
    pub dialogue_raw: Option<LufsChannel>,
    #[serde(default)]
    pub background_raw: Option<LufsChannel>,
}

#[derive(Debug, Deserialize)]
pub struct LufsChannel {
    pub integrated: f64,
    #[serde(default)]
    pub momentary: Vec<f64>,
    #[serde(default)]
    pub short_term: Vec<f64>,
}

#[derive(Debug, Deserialize)]
pub struct DiagnosticMeters {
    #[serde(default)]
    pub intelligibility_snr: f64,
    #[serde(default)]
    pub stereo_correlation: f64,
    #[serde(default)]
    pub stereo_balance: f64,
}

#[derive(Debug, Default, Deserialize)]
pub struct Semantics {
    #[serde(default)]
    pub background_tags: Vec<SemanticTag>,
}

#[derive(Debug, Deserialize)]
pub struct SemanticTag {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub score: f64,
}

#[derive(Debug, Default, Deserialize)]
pub struct Artifacts {
    #[serde(default)]
    pub stem_paths: Vec<String>,
}

/// Resolved project: payload + decoded stem samples ready for the UI.
pub struct Project {
    pub payload: MikupPayload,
    pub project_dir: PathBuf,
    pub stems: ResolvedStems,
}

pub struct ResolvedStems {
    pub dx_path: PathBuf,
    pub music_path: PathBuf,
    pub effects_path: PathBuf,
    pub dx_samples: Vec<f32>,
    pub music_samples: Vec<f32>,
    pub effects_samples: Vec<f32>,
    pub sample_rate: u32,
}

#[derive(Debug)]
pub enum ProjectError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Decode(AudioDecodeError),
    MissingStems(String),
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "project I/O error: {e}"),
            Self::Json(e) => write!(f, "payload parse error: {e}"),
            Self::Decode(e) => write!(f, "stem decode error: {e}"),
            Self::MissingStems(msg) => write!(f, "missing stems: {msg}"),
        }
    }
}

impl std::error::Error for ProjectError {}

impl From<std::io::Error> for ProjectError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<serde_json::Error> for ProjectError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

impl From<AudioDecodeError> for ProjectError {
    fn from(e: AudioDecodeError) -> Self {
        Self::Decode(e)
    }
}

pub fn scan_projects_folder(root: PathBuf) -> Vec<ProjectMetadata> {
    let projects_root = resolve_projects_root(root);
    if !projects_root.exists() {
        return Vec::new();
    }

    let mut discovered = Vec::new();
    let mut stack = vec![projects_root];

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) => {
                eprintln!(
                    "[mikup] Warning: failed to read directory {}: {err}",
                    dir.display()
                );
                continue;
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    eprintln!("[mikup] Warning: failed to read directory entry: {err}");
                    continue;
                }
            };

            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            if path
                .file_name()
                .is_some_and(|name| name == "mikup_payload.json")
            {
                if let Some(metadata) = parse_project_metadata(&path) {
                    discovered.push(metadata);
                }
            }
        }
    }

    discovered.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    discovered
}

pub fn load_config() -> AppConfig {
    let default = AppConfig {
        default_projects_dir: default_projects_dir(),
    };
    let config_path = config_path();

    let config_bytes = match std::fs::read(&config_path) {
        Ok(bytes) => bytes,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[mikup] Warning: failed to read config {}: {err}",
                    config_path.display()
                );
            }
            return default;
        }
    };

    match serde_json::from_slice::<AppConfig>(&config_bytes) {
        Ok(config) => config,
        Err(err) => {
            eprintln!(
                "[mikup] Warning: invalid config {}: {err}",
                config_path.display()
            );
            default
        }
    }
}

pub fn save_config(config: &AppConfig) -> Result<(), ProjectError> {
    let config_path = config_path();
    let bytes = serde_json::to_vec_pretty(config)?;
    std::fs::write(config_path, bytes)?;
    Ok(())
}

fn resolve_projects_root(root: PathBuf) -> PathBuf {
    if root.file_name().is_some_and(|name| name == "Projects") {
        root
    } else {
        root.join("Projects")
    }
}

fn parse_project_metadata(payload_path: &Path) -> Option<ProjectMetadata> {
    let bytes = match std::fs::read(payload_path) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!(
                "[mikup] Warning: failed to read payload {}: {err}",
                payload_path.display()
            );
            return None;
        }
    };

    let partial = match serde_json::from_slice::<PartialPayload>(&bytes) {
        Ok(partial) => partial,
        Err(err) => {
            eprintln!(
                "[mikup] Warning: invalid payload JSON {}: {err}",
                payload_path.display()
            );
            return None;
        }
    };

    let timestamp = parse_timestamp(&partial.metadata.timestamp).unwrap_or_else(|| {
        eprintln!(
            "[mikup] Warning: invalid timestamp '{}' in {}",
            partial.metadata.timestamp,
            payload_path.display()
        );
        std::time::SystemTime::UNIX_EPOCH.into()
    });

    let workspace_path = payload_path
        .parent()
        .map_or_else(PathBuf::new, Path::to_path_buf);
    let name = workspace_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown_project")
        .to_string();

    Some(ProjectMetadata {
        name,
        timestamp,
        source_path: PathBuf::from(partial.metadata.source_file),
        workspace_path,
        version: partial.metadata.pipeline_version,
    })
}

fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    if let Ok(ts) = DateTime::parse_from_rfc3339(raw) {
        return Some(ts.with_timezone(&Utc));
    }

    if let Ok(naive) = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(DateTime::from_naive_utc_and_offset(naive, Utc));
    }

    if let Ok(naive) = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S") {
        return Some(DateTime::from_naive_utc_and_offset(naive, Utc));
    }

    None
}

fn config_path() -> PathBuf {
    PathBuf::from("config.json")
}

fn default_projects_dir() -> PathBuf {
    std::env::current_dir()
        .map(|root| root.join("Projects"))
        .unwrap_or_else(|_| PathBuf::from("Projects"))
}

impl Project {
    /// Load a mikup_payload.json and decode all stems into mono sample buffers.
    /// `path` should point to the payload JSON file.
    pub fn load(path: impl AsRef<Path>) -> Result<Self, ProjectError> {
        let path = path.as_ref();
        let project_dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();

        let json_bytes = std::fs::read(path)?;
        let payload: MikupPayload = serde_json::from_slice(&json_bytes)?;

        let stems = Self::resolve_stems(&payload, &project_dir)?;

        Ok(Self {
            payload,
            project_dir,
            stems,
        })
    }

    fn resolve_stems(
        payload: &MikupPayload,
        project_dir: &Path,
    ) -> Result<ResolvedStems, ProjectError> {
        // The pipeline produces stems named *_Vocals.wav, *_Instrumental.wav, etc.
        // Mapping: first stem with "Vocal" or "DX" → dx, "Instrumental" or "Music" → music,
        // remaining → effects. Fallback: positional [0]=dx, [1]=music, [2]=effects.
        let stem_paths = &payload.artifacts.stem_paths;
        if stem_paths.len() < 3 {
            return Err(ProjectError::MissingStems(format!(
                "expected >= 3 stem_paths, got {}",
                stem_paths.len()
            )));
        }

        let resolve = |rel: &str| -> PathBuf {
            let p = Path::new(rel);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                project_dir.join(p)
            }
        };

        // Heuristic classification
        let mut dx_idx = None;
        let mut music_idx = None;
        let mut effects_idx = None;

        for (i, sp) in stem_paths.iter().enumerate() {
            let lower = sp.to_lowercase();
            if dx_idx.is_none()
                && (lower.contains("vocal") || lower.contains("dx") || lower.contains("dialogue"))
            {
                dx_idx = Some(i);
            } else if music_idx.is_none()
                && (lower.contains("instrumental") || lower.contains("music"))
            {
                music_idx = Some(i);
            }
        }

        // First unassigned stem becomes effects
        for i in 0..stem_paths.len() {
            if Some(i) != dx_idx && Some(i) != music_idx {
                effects_idx = Some(i);
                break;
            }
        }

        let dx_idx = dx_idx.unwrap_or(0);
        let music_idx = music_idx.unwrap_or(1);
        let effects_idx = effects_idx.unwrap_or(2);

        let dx_path = resolve(&stem_paths[dx_idx]);
        let music_path = resolve(&stem_paths[music_idx]);
        let effects_path = resolve(&stem_paths[effects_idx]);

        eprintln!("[mikup] Loading DX stem: {}", dx_path.display());
        let (dx_samples, dx_rate) = dsp::decode_wav_to_mono(&dx_path)?;
        eprintln!("[mikup] Loading Music stem: {}", music_path.display());
        let (music_samples, _) = dsp::decode_wav_to_mono(&music_path)?;
        eprintln!("[mikup] Loading Effects stem: {}", effects_path.display());
        let (effects_samples, _) = dsp::decode_wav_to_mono(&effects_path)?;

        Ok(ResolvedStems {
            dx_path,
            music_path,
            effects_path,
            dx_samples,
            music_samples,
            effects_samples,
            sample_rate: dx_rate,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{LazyLock, Mutex};

    use super::*;

    static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    #[test]
    fn scan_projects_folder_skips_invalid_json_and_sorts_newest_first() {
        let root = make_temp_root("scan_projects");
        let projects_dir = root.join("Projects");

        let old = projects_dir.join("episode_old");
        std::fs::create_dir_all(&old).unwrap();
        write_payload(
            old.join("mikup_payload.json"),
            "old.wav",
            "0.1.0",
            "2026-02-27T13:18:24.472952",
        );

        let recent = projects_dir.join("episode_recent");
        std::fs::create_dir_all(&recent).unwrap();
        write_payload(
            recent.join("mikup_payload.json"),
            "recent.wav",
            "0.2.0",
            "2026-03-01T07:05:00.000000",
        );

        let invalid = projects_dir.join("episode_invalid");
        std::fs::create_dir_all(&invalid).unwrap();
        std::fs::write(invalid.join("mikup_payload.json"), "{not-json").unwrap();

        let discovered = scan_projects_folder(root.clone());

        assert_eq!(discovered.len(), 2);
        assert_eq!(discovered[0].name, "episode_recent");
        assert_eq!(discovered[1].name, "episode_old");
        assert_eq!(discovered[0].source_path, PathBuf::from("recent.wav"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn load_and_save_config_round_trip() {
        let _guard = TEST_LOCK.lock().unwrap();
        let root = make_temp_root("config_round_trip");
        std::fs::create_dir_all(root.join("Projects")).unwrap();

        let cwd_guard = CwdGuard::set_to(&root);

        let loaded_default = load_config();
        let expected_default = std::env::current_dir().unwrap().join("Projects");
        assert_eq!(loaded_default.default_projects_dir, expected_default);

        let expected = AppConfig {
            default_projects_dir: root.join("CustomProjects"),
        };
        save_config(&expected).unwrap();

        let loaded_saved = load_config();
        assert_eq!(
            loaded_saved.default_projects_dir,
            expected.default_projects_dir
        );

        drop(cwd_guard);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn write_payload(path: PathBuf, source_file: &str, version: &str, timestamp: &str) {
        let body = format!(
            r#"{{
  "metadata": {{
    "source_file": "{source_file}",
    "pipeline_version": "{version}",
    "timestamp": "{timestamp}"
  }},
  "metrics": {{
    "lufs_graph": {{
      "dialogue_raw": {{
        "integrated": -20.0,
        "momentary": [0.0, 1.0, 2.0, 3.0],
        "short_term": [0.1, 0.2]
      }}
    }}
  }}
}}"#
        );
        std::fs::write(path, body).unwrap();
    }

    fn make_temp_root(prefix: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "mikup_native_{prefix}_{}_{}",
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    struct CwdGuard {
        previous_dir: PathBuf,
    }

    impl CwdGuard {
        fn set_to(path: &Path) -> Self {
            let previous_dir = std::env::current_dir().unwrap();
            std::env::set_current_dir(path).unwrap();
            Self { previous_dir }
        }
    }

    impl Drop for CwdGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.previous_dir);
        }
    }
}
