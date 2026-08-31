import { useEffect, useState } from "react";

import { fetchViewer } from "../api/instance";

const NONE: readonly string[] = [];

/**
 * What the signed-in account may do, from the viewer endpoint.
 *
 * A hook rather than a prop threaded down, for the reason
 * {@link useHousingCooperativeLogo} gives: several screens need the same answer
 * from the same endpoint, and each of them asking a route to fetch it first
 * would put the same call in every route component.
 *
 * Empty until the answer arrives, and empty on any failure. That direction is
 * deliberate and is the same one the navigation takes: a screen gains controls
 * as the answer arrives and never offers one it then withdraws, and a viewer
 * endpoint that did not respond leaves a screen read-only rather than showing
 * buttons that will be refused.
 *
 * It is not an authorization decision. The capability list is a copy of what
 * the guard enforces on every request, so hiding a control is courtesy: the
 * server refuses the call regardless of what this returns.
 */
export function useViewerCapabilities(): readonly string[] {
  const [capabilities, setCapabilities] = useState<readonly string[]>(NONE);

  useEffect(() => {
    let active = true;

    void fetchViewer().then((result) => {
      if (!active || !result.ok) {
        return;
      }
      setCapabilities(result.value.capabilities);
    });

    return () => {
      active = false;
    };
  }, []);

  return capabilities;
}
