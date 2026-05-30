use std::{
    env,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tokio::{fs, process::Command};
use uuid::Uuid;

const EDGE_TTS_TOOL_DIR: &str = "edge-tts";
const EDGE_TTS_PACKAGE: &str = "edge-tts==7.2.8";

#[derive(Debug, Deserialize)]
pub(crate) struct TtsSynthesisRequest {
    pub(crate) provider: String,
    pub(crate) text: String,
    pub(crate) voice: Option<String>,
    pub(crate) rate: Option<f64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct TtsSynthesisResponse {
    pub(crate) provider: String,
    pub(crate) mime_type: String,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) async fn synthesize_tts_audio(
    request: TtsSynthesisRequest,
) -> Result<TtsSynthesisResponse, String> {
    let provider = request.provider.trim().to_lowercase();
    match provider.as_str() {
        "edge" => synthesize_edge_tts(request).await,
        "" | "browser" => Err("Browser TTS does not synthesize audio files.".to_owned()),
        other => Err(format!("Unsupported TTS provider: {other}")),
    }
}

async fn synthesize_edge_tts(request: TtsSynthesisRequest) -> Result<TtsSynthesisResponse, String> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err("TTS text is required.".to_owned());
    }

    let command = resolve_edge_tts_command().await?;
    let voice = request
        .voice
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("zh-CN-XiaoxiaoNeural");
    let output_path = temp_tts_path();

    let mut child = Command::new(&command);
    child
        .arg("--voice")
        .arg(voice)
        .arg("--text")
        .arg(text)
        .arg("--write-media")
        .arg(&output_path);
    if let Some(rate) = request.rate {
        child.arg("--rate").arg(edge_rate_arg(rate));
    }

    let output = child.output().await.map_err(|err| {
        format!(
            "Failed to run Edge TTS command `{}`: {err}",
            command.display()
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let _ = fs::remove_file(&output_path).await;
        return Err(if stderr.is_empty() {
            format!("Edge TTS command failed with status {}", output.status)
        } else {
            format!("Edge TTS command failed: {stderr}")
        });
    }

    let bytes = fs::read(&output_path)
        .await
        .map_err(|err| format!("Failed to read Edge TTS output: {err}"))?;
    let _ = fs::remove_file(&output_path).await;
    if bytes.is_empty() {
        return Err("Edge TTS returned an empty audio file.".to_owned());
    }

    Ok(TtsSynthesisResponse {
        provider: "edge".to_owned(),
        mime_type: "audio/mpeg".to_owned(),
        bytes,
    })
}

fn temp_tts_path() -> PathBuf {
    env::temp_dir().join(format!("lantor-call-tts-{}.mp3", Uuid::new_v4()))
}

fn edge_rate_arg(rate: f64) -> String {
    let percent = ((rate.clamp(0.5, 2.0) - 1.0) * 100.0).round() as i32;
    if percent >= 0 {
        format!("+{percent}%")
    } else {
        format!("{percent}%")
    }
}

async fn resolve_edge_tts_command() -> Result<PathBuf, String> {
    if let Ok(command) = env::var("LANTOR_EDGE_TTS_COMMAND") {
        let command = command.trim();
        if !command.is_empty() {
            return Ok(PathBuf::from(command));
        }
    }

    for root in edge_tts_tool_roots() {
        let command = edge_tts_command_path(&root);
        if command.is_file() {
            return Ok(command);
        }
    }

    if command_exists("edge-tts").await {
        return Ok(PathBuf::from("edge-tts"));
    }

    install_edge_tts_tool().await
}

async fn install_edge_tts_tool() -> Result<PathBuf, String> {
    let python = resolve_python_command().await?;
    let mut last_error = None;

    for root in edge_tts_tool_roots() {
        match install_edge_tts_tool_at(&python, &root).await {
            Ok(command) => return Ok(command),
            Err(err) => last_error = Some(err),
        }
    }

    Err(last_error
        .unwrap_or_else(|| "No writable Lantor Edge TTS tool directory was available.".to_owned()))
}

async fn install_edge_tts_tool_at(python: &Path, root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(root).await.map_err(|err| {
        format!(
            "Failed to create Edge TTS tool directory `{}`: {err}",
            root.display()
        )
    })?;

    let venv_python = venv_python_path(root);
    if !venv_python.is_file() {
        run_command(
            Command::new(python).arg("-m").arg("venv").arg(root),
            "create Edge TTS virtual environment",
        )
        .await?;
    }

    run_command(
        Command::new(&venv_python)
            .arg("-m")
            .arg("pip")
            .arg("install")
            .arg("--disable-pip-version-check")
            .arg(EDGE_TTS_PACKAGE),
        "install Edge TTS package",
    )
    .await?;

    let command = edge_tts_command_path(root);
    if command.is_file() {
        Ok(command)
    } else {
        Err(format!(
            "Edge TTS installed but command was not found at `{}`.",
            command.display()
        ))
    }
}

async fn resolve_python_command() -> Result<PathBuf, String> {
    if let Ok(command) = env::var("LANTOR_PYTHON_COMMAND") {
        let command = command.trim();
        if !command.is_empty() {
            return Ok(PathBuf::from(command));
        }
    }

    for candidate in ["python3", "python"] {
        if command_exists(candidate).await {
            return Ok(PathBuf::from(candidate));
        }
    }

    Err("Python is required to install Edge TTS automatically, but no python3/python command was found.".to_owned())
}

async fn command_exists(command: &str) -> bool {
    Command::new(command)
        .arg("--version")
        .output()
        .await
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn run_command(command: &mut Command, action: &str) -> Result<(), String> {
    let output = command
        .output()
        .await
        .map_err(|err| format!("Failed to {action}: {err}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        output.status.to_string()
    };
    Err(format!("Failed to {action}: {detail}"))
}

fn edge_tts_tool_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("tools").join(EDGE_TTS_TOOL_DIR));
        }
    }
    if let Some(home) = home_dir() {
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Lantor")
                .join("tools")
                .join(EDGE_TTS_TOOL_DIR),
        );
    }
    roots
}

#[cfg(windows)]
fn edge_tts_command_path(root: &Path) -> PathBuf {
    root.join("Scripts").join("edge-tts.exe")
}

#[cfg(not(windows))]
fn edge_tts_command_path(root: &Path) -> PathBuf {
    root.join("bin").join("edge-tts")
}

#[cfg(windows)]
fn venv_python_path(root: &Path) -> PathBuf {
    root.join("Scripts").join("python.exe")
}

#[cfg(not(windows))]
fn venv_python_path(root: &Path) -> PathBuf {
    root.join("bin").join("python")
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_edge_rate_percent() {
        assert_eq!(edge_rate_arg(1.0), "+0%");
        assert_eq!(edge_rate_arg(1.25), "+25%");
        assert_eq!(edge_rate_arg(0.75), "-25%");
        assert_eq!(edge_rate_arg(3.0), "+100%");
    }

    #[test]
    fn resolves_edge_tts_command_inside_venv() {
        let root = PathBuf::from("/tmp/lantor/tools/edge-tts");
        let command = edge_tts_command_path(&root);
        assert!(command.starts_with(&root));
        assert!(command.to_string_lossy().contains("edge-tts"));
    }
}
