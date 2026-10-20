import { useEffect, useState } from "react";

import { fetchViewer, type Viewer } from "../api/instance";

/** What a support session says about itself. */
export type SupportSessionView = NonNullable<Viewer["support"]>;

/**
 * The support session this browser is (ADR 0028), or null for an account and
 * until the answer arrives.
 *
 * Asked of the viewer endpoint, which answers a support session's cookie,
 * because the cookie is HttpOnly and nothing in the page can read it. Null on
 * any failure: the banner it drives is courtesy, and the server refuses every
 * change a support session sends whatever the page shows.
 */
export function useSupportSession(): SupportSessionView | null {
  const [support, setSupport] = useState<SupportSessionView | null>(null);

  useEffect(() => {
    let active = true;
    void fetchViewer().then((result) => {
      if (active && result.ok) {
        setSupport(result.value.support ?? null);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return support;
}
