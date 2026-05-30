import { useCallback, useMemo, useState } from "react";
import {
  requestCallCapturePermission,
  resolveCallCaptureProviderBoundary,
  type CallCapturePermissionStatus,
} from "../callModeCaptureProvider";

export function useCallCaptureProvider() {
  const boundary = useMemo(() => resolveCallCaptureProviderBoundary(), []);
  const [permissionStatus, setPermissionStatus] = useState<CallCapturePermissionStatus>("unknown");
  const [error, setError] = useState<string | null>(boundary.unavailableReason);

  const requestPermission = useCallback(async () => {
    if (boundary.supportStatus !== "supported") {
      setPermissionStatus("denied");
      setError(boundary.unavailableReason ?? "Call capture is not supported.");
      return false;
    }

    setPermissionStatus("requesting");
    setError(null);
    const result = await requestCallCapturePermission(boundary);
    if (result.granted) {
      setPermissionStatus("granted");
      setError(null);
      return true;
    }
    setPermissionStatus("denied");
    setError(result.error);
    return false;
  }, [boundary]);

  return {
    boundary,
    error,
    isRequestingPermission: permissionStatus === "requesting",
    isSupported: boundary.supportStatus === "supported",
    permissionStatus,
    requestPermission,
  };
}

