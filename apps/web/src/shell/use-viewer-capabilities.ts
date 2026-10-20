import { useEffect, useState } from "react";

import { fetchViewer } from "../api/instance";
import { isReadOnly } from "../support/read-only";

/** What the signed-in viewer may do, as a screen without a viewer asks it. */
export interface ViewerAccess {
  capabilities: readonly string[];
  /**
   * Whether the screen may offer no control that sends a change: a support
   * session (ADR 0028), and every viewer until the answer arrives.
   */
  readOnly: boolean;
}

const UNKNOWN: ViewerAccess = { capabilities: [], readOnly: true };

/**
 * What the signed-in account may do, from the viewer endpoint.
 *
 * A hook rather than a prop threaded down, for the reason
 * {@link useHousingCooperativeLogo} gives: several screens need the same answer
 * from the same endpoint, and each of them asking a route to fetch it first
 * would put the same call in every route component.
 *
 * Empty and read-only until the answer arrives, and so on any failure. That
 * direction is deliberate and is the same one the navigation takes: a screen
 * gains controls as the answer arrives and never offers one it then withdraws,
 * and a viewer endpoint that did not respond leaves a screen read-only rather
 * than showing buttons that will be refused. Both come from the one answer, so
 * a support session's capabilities never arrive before the word that it
 * changes nothing.
 *
 * It is not an authorization decision. The capability list is a copy of what
 * the guard enforces on every request, so hiding a control is courtesy: the
 * server refuses the call regardless of what this returns.
 */
export function useViewerAccess(): ViewerAccess {
  const [access, setAccess] = useState<ViewerAccess>(UNKNOWN);

  useEffect(() => {
    let active = true;

    void fetchViewer().then((result) => {
      if (!active || !result.ok) {
        return;
      }
      setAccess({
        capabilities: result.value.capabilities,
        readOnly: isReadOnly(result.value),
      });
    });

    return () => {
      active = false;
    };
  }, []);

  return access;
}

/** The capabilities alone, for a screen whose every control a capability gates. */
export function useViewerCapabilities(): readonly string[] {
  return useViewerAccess().capabilities;
}
