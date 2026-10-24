import { useSyncExternalStore } from "react";

import {
  residentPreview,
  subscribeToResidentPreview,
  type ResidentPreview,
} from "../api/viewer-preview";

/** The resident preview as it stands, rendering again on every change. */
export function useResidentPreview(): ResidentPreview {
  return useSyncExternalStore(
    subscribeToResidentPreview,
    residentPreview,
    residentPreview,
  );
}
