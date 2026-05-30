import { apiInvoke, isTauriRuntime } from "./apiClient";
import {
  MEDIA_RECORDER_AUDIO_MIME_TYPES,
  supportedMediaRecorderAudioMimeType,
} from "./mediaRecorderAudio";

export type CallCaptureProviderId = "browser-media-recorder";
export type CallCapturePermissionStatus = "unknown" | "requesting" | "granted" | "denied";
export type CallCaptureSupportStatus = "supported" | "unsupported";
export type CallCapturePermissionModel =
  | "tauri-native-permission-plus-browser-capture"
  | "browser-get-user-media";

export type CallCaptureProviderBoundary = {
  id: CallCaptureProviderId;
  label: string;
  supportStatus: CallCaptureSupportStatus;
  permissionModel: CallCapturePermissionModel;
  captureApi: "MediaRecorder";
  sttBoundary: "call_session_submit_utterance";
  segmentation: "live-utterance-segments";
  mimeType: string;
  unavailableReason: string | null;
};

export type CallCaptureProviderEnvironment = {
  hasWindow: boolean;
  hasMediaRecorder: boolean;
  hasGetUserMedia: boolean;
  isSecureContext: boolean;
  isTauri: boolean;
  supportedMimeType: string;
};

export type RequestCallCapturePermissionResult = {
  granted: boolean;
  error: string | null;
};

export const CALL_CAPTURE_MIME_TYPES = MEDIA_RECORDER_AUDIO_MIME_TYPES;

function mediaRecorderSupportedMimeType() {
  return supportedMediaRecorderAudioMimeType();
}

export function currentCallCaptureProviderEnvironment(): CallCaptureProviderEnvironment {
  const hasWindow = typeof window !== "undefined";
  const hasNavigator = typeof navigator !== "undefined";
  return {
    hasWindow,
    hasMediaRecorder: typeof MediaRecorder !== "undefined",
    hasGetUserMedia: hasNavigator && Boolean(navigator.mediaDevices?.getUserMedia),
    isSecureContext: hasWindow && window.isSecureContext,
    isTauri: isTauriRuntime(),
    supportedMimeType: mediaRecorderSupportedMimeType(),
  };
}

export function resolveCallCaptureProviderBoundary(
  environment: CallCaptureProviderEnvironment = currentCallCaptureProviderEnvironment(),
): CallCaptureProviderBoundary {
  const permissionModel: CallCapturePermissionModel = environment.isTauri
    ? "tauri-native-permission-plus-browser-capture"
    : "browser-get-user-media";
  let unavailableReason: string | null = null;
  if (!environment.hasWindow) {
    unavailableReason = "Call capture requires a browser or Tauri WebView.";
  } else if (!environment.isSecureContext && !environment.isTauri) {
    unavailableReason = "Microphone capture requires HTTPS or localhost.";
  } else if (!environment.hasMediaRecorder) {
    unavailableReason = "Continuous microphone capture is not supported in this WebView.";
  } else if (!environment.hasGetUserMedia) {
    unavailableReason = "Microphone access is not available in this WebView.";
  }

  return {
    id: "browser-media-recorder",
    label: "Browser mic to backend STT",
    supportStatus: unavailableReason ? "unsupported" : "supported",
    permissionModel,
    captureApi: "MediaRecorder",
    sttBoundary: "call_session_submit_utterance",
    segmentation: "live-utterance-segments",
    mimeType: environment.supportedMimeType || "application/octet-stream",
    unavailableReason,
  };
}

function microphonePermissionError(err: unknown) {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      return "Microphone permission is blocked.";
    }
    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      return "No microphone was found.";
    }
    if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      return "Microphone is already in use.";
    }
  }
  return err instanceof Error ? err.message : "Microphone permission could not be requested.";
}

function shouldBlockForSpeechPermissionError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return !message.includes("only implemented for macOS");
}

async function requestNativeCallCapturePermissions() {
  await apiInvoke("request_microphone_permission");
  try {
    await apiInvoke("request_speech_recognition_permission");
  } catch (err) {
    if (shouldBlockForSpeechPermissionError(err)) throw err;
  }
}

export async function requestCallCapturePermission(
  boundary: CallCaptureProviderBoundary = resolveCallCaptureProviderBoundary(),
): Promise<RequestCallCapturePermissionResult> {
  if (boundary.supportStatus !== "supported") {
    return {
      granted: false,
      error: boundary.unavailableReason ?? "Call capture is not supported.",
    };
  }

  try {
    if (boundary.permissionModel === "tauri-native-permission-plus-browser-capture") {
      await requestNativeCallCapturePermissions();
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return {
        granted: false,
        error: "Microphone access is not available in this WebView.",
      };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return { granted: true, error: null };
  } catch (err) {
    return { granted: false, error: microphonePermissionError(err) };
  }
}
