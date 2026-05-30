use std::{
    env, fs,
    path::PathBuf,
    process::{ExitStatus, Stdio},
    sync::mpsc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    task::JoinHandle,
    time::timeout,
};

pub(crate) const VOICE_AUDIO_SIZE_LIMIT: usize = 25 * 1024 * 1024;
const COMMAND_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(60);
const APPLE_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(75);
const DETERMINISTIC_TRANSCRIPT_PREFIX: &[u8] = b"LANTOR_TRANSCRIPT:";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceTranscriptionRequest {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime_type: String,
    #[serde(default)]
    pub(crate) original_name: Option<String>,
    #[serde(default)]
    pub(crate) duration_ms: Option<u32>,
    #[serde(default)]
    pub(crate) language: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceTranscriptionResponse {
    pub(crate) text: String,
    pub(crate) provider: String,
    pub(crate) mime_type: String,
    pub(crate) original_name: Option<String>,
    pub(crate) duration_ms: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceTranscriptionError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl VoiceTranscriptionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn command_message(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

#[derive(Debug)]
enum TranscriptionProvider {
    Apple,
    Command(String),
    Deterministic,
}

#[derive(Debug, Clone)]
struct ValidatedVoiceInput {
    bytes: Vec<u8>,
    mime_type: String,
    original_name: Option<String>,
    duration_ms: Option<u32>,
    language: Option<String>,
}

struct ProviderCommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

pub(crate) async fn transcribe_voice_audio(
    request: VoiceTranscriptionRequest,
) -> Result<VoiceTranscriptionResponse, VoiceTranscriptionError> {
    let input = validate_voice_transcription_request(request)?;
    let provider = transcription_provider_from_env()?;
    transcribe_with_provider(input, provider).await
}

async fn transcribe_with_provider(
    input: ValidatedVoiceInput,
    provider: TranscriptionProvider,
) -> Result<VoiceTranscriptionResponse, VoiceTranscriptionError> {
    let (text, provider_name) = match provider {
        TranscriptionProvider::Apple => {
            let text = transcribe_with_apple(&input).await?;
            (text, "apple".to_owned())
        }
        TranscriptionProvider::Command(command_line) => {
            let text = transcribe_with_command(&command_line, &input).await?;
            (text, "command".to_owned())
        }
        TranscriptionProvider::Deterministic => (
            deterministic_transcript(&input)?,
            "deterministic".to_owned(),
        ),
    };

    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err(VoiceTranscriptionError::new(
            "emptyTranscript",
            "Transcription provider returned no text.",
        ));
    }

    Ok(VoiceTranscriptionResponse {
        text,
        provider: provider_name,
        mime_type: input.mime_type,
        original_name: input.original_name,
        duration_ms: input.duration_ms,
    })
}

fn validate_voice_transcription_request(
    request: VoiceTranscriptionRequest,
) -> Result<ValidatedVoiceInput, VoiceTranscriptionError> {
    if request.bytes.is_empty() {
        return Err(VoiceTranscriptionError::new(
            "emptyAudio",
            "Voice audio is required.",
        ));
    }
    if request.bytes.len() > VOICE_AUDIO_SIZE_LIMIT {
        return Err(VoiceTranscriptionError::new(
            "audioTooLarge",
            format!(
                "Voice audio is too large. Maximum size is {} MB.",
                VOICE_AUDIO_SIZE_LIMIT / 1024 / 1024
            ),
        ));
    }

    let mime_type = request.mime_type.trim().to_ascii_lowercase();
    if mime_type.is_empty() {
        return Err(VoiceTranscriptionError::new(
            "missingMimeType",
            "Voice audio MIME type is required.",
        ));
    }
    if !mime_type.starts_with("audio/") && mime_type != "application/octet-stream" {
        return Err(VoiceTranscriptionError::new(
            "unsupportedMimeType",
            format!("Voice audio MIME type is not supported: {mime_type}"),
        ));
    }

    let original_name = request
        .original_name
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if original_name
        .as_deref()
        .is_some_and(|value| value.len() > 255)
    {
        return Err(VoiceTranscriptionError::new(
            "filenameTooLong",
            "Voice audio filename is too long.",
        ));
    }

    let language = request
        .language
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if language.as_deref().is_some_and(|value| value.len() > 32) {
        return Err(VoiceTranscriptionError::new(
            "languageTooLong",
            "Voice transcription language hint is too long.",
        ));
    }

    Ok(ValidatedVoiceInput {
        bytes: request.bytes,
        mime_type,
        original_name,
        duration_ms: request.duration_ms,
        language,
    })
}

fn transcription_provider_from_env() -> Result<TranscriptionProvider, VoiceTranscriptionError> {
    let provider = env::var("LANTOR_TRANSCRIPTION_PROVIDER")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let command = env::var("LANTOR_TRANSCRIPTION_COMMAND")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    match provider.as_deref() {
        Some("apple") | Some("apple-speech") | Some("native") | Some("system") => {
            Ok(TranscriptionProvider::Apple)
        }
        Some("deterministic") | Some("mock") | Some("test") => Ok(TranscriptionProvider::Deterministic),
        Some("command") => command.map(TranscriptionProvider::Command).ok_or_else(|| {
            VoiceTranscriptionError::new(
                "providerNotConfigured",
                "LANTOR_TRANSCRIPTION_PROVIDER=command requires LANTOR_TRANSCRIPTION_COMMAND.",
            )
        }),
        Some(other) => Err(VoiceTranscriptionError::new(
            "unsupportedProvider",
            format!("Unsupported transcription provider: {other}"),
        )),
        #[cfg(target_os = "macos")]
        None if command.is_none() => Ok(TranscriptionProvider::Apple),
        #[cfg(not(target_os = "macos"))]
        None => command.map(TranscriptionProvider::Command).ok_or_else(|| {
            VoiceTranscriptionError::new(
                "providerNotConfigured",
                "Configure LANTOR_TRANSCRIPTION_COMMAND, or set LANTOR_TRANSCRIPTION_PROVIDER=deterministic for local verification.",
            )
        }),
        #[cfg(target_os = "macos")]
        None => command.map(TranscriptionProvider::Command).ok_or_else(|| {
            VoiceTranscriptionError::new(
                "providerNotConfigured",
                "Configure LANTOR_TRANSCRIPTION_COMMAND, set LANTOR_TRANSCRIPTION_PROVIDER=apple, or set LANTOR_TRANSCRIPTION_PROVIDER=deterministic for local verification.",
            )
        }),
    }
}

async fn transcribe_with_apple(
    input: &ValidatedVoiceInput,
) -> Result<String, VoiceTranscriptionError> {
    let input = input.clone();
    tauri::async_runtime::spawn_blocking(move || transcribe_with_apple_blocking(&input))
        .await
        .map_err(|err| {
            VoiceTranscriptionError::new(
                "providerFailed",
                format!("Apple speech transcription task failed: {err}"),
            )
        })?
}

#[cfg(not(target_os = "macos"))]
fn transcribe_with_apple_blocking(
    _input: &ValidatedVoiceInput,
) -> Result<String, VoiceTranscriptionError> {
    Err(VoiceTranscriptionError::new(
        "unsupportedProvider",
        "Apple speech transcription is only available on macOS.",
    ))
}

#[cfg(target_os = "macos")]
fn transcribe_with_apple_blocking(
    input: &ValidatedVoiceInput,
) -> Result<String, VoiceTranscriptionError> {
    use objc2::AllocAnyThread;
    use objc2_foundation::{NSLocale, NSString};
    use objc2_speech::{SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus};

    let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
    if status != SFSpeechRecognizerAuthorizationStatus::Authorized {
        return Err(VoiceTranscriptionError::new(
            "speechPermissionRequired",
            "Speech recognition permission is required. Use the existing voice input once or allow Speech Recognition for Lantor in macOS settings.",
        ));
    }

    let recognizer = if let Some(language) = input.language.as_deref() {
        let locale_identifier = NSString::from_str(language);
        let locale = NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &locale_identifier);
        unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale) }
    } else {
        unsafe { SFSpeechRecognizer::init(SFSpeechRecognizer::alloc()) }
    }
    .ok_or_else(|| {
        VoiceTranscriptionError::new(
            "providerUnavailable",
            "Apple speech recognizer is not available for this locale.",
        )
    })?;

    if !unsafe { recognizer.isAvailable() } {
        return Err(VoiceTranscriptionError::new(
            "providerUnavailable",
            "Apple speech recognition is currently unavailable.",
        ));
    }

    let path = write_apple_audio_temp_file(input)?;
    let result = recognize_apple_audio_file(&recognizer, &path);
    let _ = fs::remove_file(&path);
    result
}

#[cfg(target_os = "macos")]
fn recognize_apple_audio_file(
    recognizer: &objc2_speech::SFSpeechRecognizer,
    path: &PathBuf,
) -> Result<String, VoiceTranscriptionError> {
    use block2::RcBlock;
    use objc2::{rc::Retained, AllocAnyThread, ClassType};
    use objc2_foundation::{NSError, NSURL};
    use objc2_speech::{SFSpeechRecognitionResult, SFSpeechURLRecognitionRequest};

    enum AppleSpeechEvent {
        Error(String),
        Result { text: String, is_final: bool },
    }

    let url = NSURL::from_file_path(path).ok_or_else(|| {
        VoiceTranscriptionError::new(
            "providerInvalidInput",
            "Failed to create an Apple speech file URL for recorded audio.",
        )
    })?;
    let request = unsafe {
        SFSpeechURLRecognitionRequest::initWithURL(SFSpeechURLRecognitionRequest::alloc(), &url)
    };
    unsafe {
        request.setShouldReportPartialResults(false);
        request.setAddsPunctuation(true);
        if recognizer.supportsOnDeviceRecognition() {
            request.setRequiresOnDeviceRecognition(true);
        }
    }

    let (sender, receiver) = mpsc::channel();
    let completion = RcBlock::new(
        move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
            if !error.is_null() {
                let message = unsafe { Retained::retain(error) }
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "Apple speech recognition failed.".to_owned());
                let _ = sender.send(AppleSpeechEvent::Error(message));
                return;
            }
            if !result.is_null() {
                let Some(result) = (unsafe { Retained::retain(result) }) else {
                    return;
                };
                let transcription = unsafe { result.bestTranscription() };
                let text = unsafe { transcription.formattedString() }.to_string();
                let is_final = unsafe { result.isFinal() };
                let _ = sender.send(AppleSpeechEvent::Result { text, is_final });
            }
        },
    );

    let task = unsafe {
        recognizer.recognitionTaskWithRequest_resultHandler(request.as_super(), &completion)
    };

    let deadline = std::time::Instant::now() + APPLE_TRANSCRIPTION_TIMEOUT;
    let mut last_text = String::new();
    loop {
        let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
            unsafe { task.cancel() };
            return Err(VoiceTranscriptionError::new(
                "providerTimedOut",
                "Apple speech recognition timed out.",
            ));
        };
        match receiver.recv_timeout(remaining) {
            Ok(AppleSpeechEvent::Error(message)) => {
                unsafe { task.cancel() };
                return Err(VoiceTranscriptionError::new("providerFailed", message));
            }
            Ok(AppleSpeechEvent::Result { text, is_final }) => {
                if !text.trim().is_empty() {
                    last_text = text;
                }
                if is_final {
                    return Ok(last_text);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                unsafe { task.cancel() };
                return Err(VoiceTranscriptionError::new(
                    "providerTimedOut",
                    "Apple speech recognition timed out.",
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                unsafe { task.cancel() };
                return Err(VoiceTranscriptionError::new(
                    "providerFailed",
                    "Apple speech recognition stopped before returning a result.",
                ));
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn write_apple_audio_temp_file(
    input: &ValidatedVoiceInput,
) -> Result<PathBuf, VoiceTranscriptionError> {
    let mut path = env::temp_dir();
    path.push(format!(
        "lantor-apple-speech-{}-{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4(),
        apple_audio_extension(input),
    ));
    fs::write(&path, &input.bytes).map_err(|err| {
        VoiceTranscriptionError::new(
            "providerIoFailed",
            format!("Failed to write temporary audio for Apple speech recognition: {err}"),
        )
    })?;
    Ok(path)
}

#[cfg(target_os = "macos")]
fn apple_audio_extension(input: &ValidatedVoiceInput) -> &'static str {
    if input.mime_type.contains("mp4") || input.mime_type.contains("aac") {
        "m4a"
    } else if input.mime_type.contains("mpeg") || input.mime_type.contains("mp3") {
        "mp3"
    } else if input.mime_type.contains("wav") {
        "wav"
    } else if input.mime_type.contains("aiff") {
        "aiff"
    } else if input.mime_type.contains("ogg") {
        "ogg"
    } else if input.mime_type.contains("webm") {
        "webm"
    } else {
        "audio"
    }
}

async fn transcribe_with_command(
    command_line: &str,
    input: &ValidatedVoiceInput,
) -> Result<String, VoiceTranscriptionError> {
    transcribe_with_command_timeout(command_line, input, COMMAND_TRANSCRIPTION_TIMEOUT).await
}

async fn transcribe_with_command_timeout(
    command_line: &str,
    input: &ValidatedVoiceInput,
    timeout_duration: Duration,
) -> Result<String, VoiceTranscriptionError> {
    let mut command = shell_command(command_line);
    command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LANTOR_TRANSCRIPTION_MIME_TYPE", &input.mime_type)
        .env(
            "LANTOR_TRANSCRIPTION_ORIGINAL_NAME",
            input.original_name.as_deref().unwrap_or(""),
        )
        .env(
            "LANTOR_TRANSCRIPTION_DURATION_MS",
            input
                .duration_ms
                .map(|value| value.to_string())
                .unwrap_or_default(),
        )
        .env(
            "LANTOR_TRANSCRIPTION_LANGUAGE",
            input.language.as_deref().unwrap_or(""),
        );

    let mut child = command.spawn().map_err(|err| {
        VoiceTranscriptionError::new(
            "providerStartFailed",
            format!("Failed to start transcription command: {err}"),
        )
    })?;

    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill().await;
        return Err(VoiceTranscriptionError::new(
            "providerStartFailed",
            "Failed to open transcription command stdin.",
        ));
    };

    match timeout(timeout_duration, stdin.write_all(&input.bytes)).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let _ = child.kill().await;
            return Err(VoiceTranscriptionError::new(
                "providerIoFailed",
                format!("Failed to write audio to transcription command: {err}"),
            ));
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(VoiceTranscriptionError::new(
                "providerTimedOut",
                "Transcription command timed out.",
            ));
        }
    }
    drop(stdin);

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return Err(VoiceTranscriptionError::new(
            "providerStartFailed",
            "Failed to open transcription command stdout.",
        ));
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill().await;
        return Err(VoiceTranscriptionError::new(
            "providerStartFailed",
            "Failed to open transcription command stderr.",
        ));
    };

    let stdout_task = read_pipe_to_end(stdout);
    let stderr_task = read_pipe_to_end(stderr);
    let status = match timeout(timeout_duration, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(err)) => {
            let _ = child.kill().await;
            return Err(VoiceTranscriptionError::new(
                "providerIoFailed",
                format!("Failed to wait for transcription command: {err}"),
            ));
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(VoiceTranscriptionError::new(
                "providerTimedOut",
                "Transcription command timed out.",
            ));
        }
    };

    let output = ProviderCommandOutput {
        status,
        stdout: collect_provider_pipe(stdout_task, "stdout").await?,
        stderr: collect_provider_pipe(stderr_task, "stderr").await?,
    };

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(VoiceTranscriptionError::new(
            "providerFailed",
            if detail.is_empty() {
                format!(
                    "Transcription command exited with status {}.",
                    output.status
                )
            } else {
                detail
            },
        ));
    }

    let stdout = String::from_utf8(output.stdout).map_err(|_| {
        VoiceTranscriptionError::new(
            "providerInvalidOutput",
            "Transcription command stdout was not valid UTF-8.",
        )
    })?;
    parse_provider_stdout(&stdout)
}

fn read_pipe_to_end<R>(mut pipe: R) -> JoinHandle<std::io::Result<Vec<u8>>>
where
    R: AsyncRead + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut bytes = Vec::new();
        pipe.read_to_end(&mut bytes).await?;
        Ok(bytes)
    })
}

async fn collect_provider_pipe(
    task: JoinHandle<std::io::Result<Vec<u8>>>,
    pipe_name: &'static str,
) -> Result<Vec<u8>, VoiceTranscriptionError> {
    match task.await {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(err)) => Err(VoiceTranscriptionError::new(
            "providerIoFailed",
            format!("Failed to read transcription command {pipe_name}: {err}"),
        )),
        Err(err) => Err(VoiceTranscriptionError::new(
            "providerIoFailed",
            format!("Failed to join transcription command {pipe_name} reader: {err}"),
        )),
    }
}

#[cfg(windows)]
fn shell_command(command_line: &str) -> Command {
    let mut command = Command::new("cmd");
    command.arg("/C").arg(command_line);
    command
}

#[cfg(not(windows))]
fn shell_command(command_line: &str) -> Command {
    let mut command = Command::new("sh");
    command.arg("-c").arg(command_line);
    command
}

fn parse_provider_stdout(stdout: &str) -> Result<String, VoiceTranscriptionError> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(text) = value.get("text").and_then(Value::as_str) {
            return Ok(text.to_owned());
        }
        return Err(VoiceTranscriptionError::new(
            "providerInvalidOutput",
            "Transcription command JSON output must include a string text field.",
        ));
    }
    Ok(trimmed.to_owned())
}

fn deterministic_transcript(
    input: &ValidatedVoiceInput,
) -> Result<String, VoiceTranscriptionError> {
    if let Some(rest) = input.bytes.strip_prefix(DETERMINISTIC_TRANSCRIPT_PREFIX) {
        let text = String::from_utf8(rest.to_vec()).map_err(|_| {
            VoiceTranscriptionError::new(
                "invalidDeterministicTranscript",
                "Deterministic transcript marker must be followed by UTF-8 text.",
            )
        })?;
        return Ok(text.trim().to_owned());
    }

    let digest = Sha256::digest(&input.bytes);
    Ok(format!(
        "Deterministic voice transcript for {} bytes of {} audio, sha256={:.16x}",
        input.bytes.len(),
        input.mime_type,
        digest
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static VOICE_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_voice_provider_env<T>(
        provider: Option<&str>,
        command: Option<&str>,
        run: impl FnOnce() -> T,
    ) -> T {
        let _guard = VOICE_ENV_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let previous_provider = env::var("LANTOR_TRANSCRIPTION_PROVIDER").ok();
        let previous_command = env::var("LANTOR_TRANSCRIPTION_COMMAND").ok();

        match provider {
            Some(value) => env::set_var("LANTOR_TRANSCRIPTION_PROVIDER", value),
            None => env::remove_var("LANTOR_TRANSCRIPTION_PROVIDER"),
        }
        match command {
            Some(value) => env::set_var("LANTOR_TRANSCRIPTION_COMMAND", value),
            None => env::remove_var("LANTOR_TRANSCRIPTION_COMMAND"),
        }

        let result = run();

        match previous_provider {
            Some(value) => env::set_var("LANTOR_TRANSCRIPTION_PROVIDER", value),
            None => env::remove_var("LANTOR_TRANSCRIPTION_PROVIDER"),
        }
        match previous_command {
            Some(value) => env::set_var("LANTOR_TRANSCRIPTION_COMMAND", value),
            None => env::remove_var("LANTOR_TRANSCRIPTION_COMMAND"),
        }

        result
    }

    fn request(bytes: &[u8]) -> VoiceTranscriptionRequest {
        VoiceTranscriptionRequest {
            bytes: bytes.to_vec(),
            mime_type: "audio/webm".to_owned(),
            original_name: Some("voice.webm".to_owned()),
            duration_ms: Some(1200),
            language: Some("en".to_owned()),
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn provider_env_reports_not_configured_without_provider_or_command() {
        let err = with_voice_provider_env(None, None, || {
            transcription_provider_from_env().expect_err("provider should be required")
        });

        assert_eq!(err.code, "providerNotConfigured");
        assert!(err
            .message
            .contains("Configure LANTOR_TRANSCRIPTION_COMMAND"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn provider_env_defaults_to_apple_on_macos() {
        let provider = with_voice_provider_env(None, None, || {
            transcription_provider_from_env().expect("apple provider should be default on macOS")
        });

        assert!(matches!(provider, TranscriptionProvider::Apple));
    }

    #[test]
    fn provider_env_selects_apple_aliases() {
        for alias in ["apple", "apple-speech", "native", "system"] {
            let provider = with_voice_provider_env(Some(alias), None, || {
                transcription_provider_from_env().expect("apple provider alias")
            });

            assert!(matches!(provider, TranscriptionProvider::Apple));
        }
    }

    #[test]
    fn provider_env_selects_deterministic_provider_for_local_smoke() {
        let provider = with_voice_provider_env(Some("mock"), None, || {
            transcription_provider_from_env().expect("mock provider")
        });
        let input = validate_voice_transcription_request(request(
            b"LANTOR_TRANSCRIPT:send reviewed transcript to the active channel",
        ))
        .expect("valid request");

        let result = tauri::async_runtime::block_on(transcribe_with_provider(input, provider))
            .expect("deterministic transcript");

        assert_eq!(
            result.text,
            "send reviewed transcript to the active channel"
        );
        assert_eq!(result.provider, "deterministic");
    }

    #[tokio::test]
    async fn deterministic_provider_uses_marker_text() {
        let input = validate_voice_transcription_request(request(
            b"LANTOR_TRANSCRIPT:send this to the design agent",
        ))
        .expect("valid request");

        let result = transcribe_with_provider(input, TranscriptionProvider::Deterministic)
            .await
            .expect("deterministic transcript");

        assert_eq!(result.text, "send this to the design agent");
        assert_eq!(result.provider, "deterministic");
        assert_eq!(result.mime_type, "audio/webm");
        assert_eq!(result.original_name.as_deref(), Some("voice.webm"));
        assert_eq!(result.duration_ms, Some(1200));
    }

    #[tokio::test]
    async fn deterministic_provider_has_stable_fallback_text() {
        let input = validate_voice_transcription_request(request(b"not real audio"))
            .expect("valid request");

        let result = transcribe_with_provider(input, TranscriptionProvider::Deterministic)
            .await
            .expect("deterministic transcript");

        assert!(result.text.contains("14 bytes of audio/webm audio"));
        assert!(result.text.contains("sha256="));
    }

    #[test]
    fn validation_rejects_non_audio_mime_type() {
        let mut request = request(b"audio");
        request.mime_type = "text/plain".to_owned();

        let err = validate_voice_transcription_request(request).expect_err("mime rejected");

        assert_eq!(err.code, "unsupportedMimeType");
    }

    #[test]
    fn provider_stdout_accepts_plain_text_or_json_text() {
        assert_eq!(
            parse_provider_stdout("plain transcript\n").expect("plain text"),
            "plain transcript"
        );
        assert_eq!(
            parse_provider_stdout(r#"{"text":"json transcript"}"#).expect("json text"),
            "json transcript"
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn command_provider_reads_stdout() {
        let input =
            validate_voice_transcription_request(request(b"audio bytes")).expect("valid request");

        let text = transcribe_with_command_timeout(
            r#"cat >/dev/null; printf '{"text":"command transcript"}'"#,
            &input,
            Duration::from_secs(2),
        )
        .await
        .expect("command transcript");

        assert_eq!(text, "command transcript");
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn timed_out_command_is_terminated() {
        let marker_path = std::env::temp_dir().join(format!(
            "lantor-voice-timeout-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let command_line = format!("sleep 0.4; touch {}", marker_path.display());
        let input =
            validate_voice_transcription_request(request(b"audio bytes")).expect("valid request");

        let err = transcribe_with_command_timeout(&command_line, &input, Duration::from_millis(50))
            .await
            .expect_err("command should time out");

        assert_eq!(err.code, "providerTimedOut");
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(
            !marker_path.exists(),
            "timed-out provider command should not continue to completion"
        );
        let _ = std::fs::remove_file(marker_path);
    }
}
