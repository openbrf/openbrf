import type { Viewer } from "../api/instance";

/** A support session as the viewer endpoint describes it, for a test. */
export const SUPPORT_SESSION: NonNullable<Viewer["support"]> = {
  supporter: "Kim at the host",
  endsAt: "2026-10-20T18:00:00.000Z",
};

/** The same viewer, as a support session under the access it opened. */
export function asSupportSession(viewer: Viewer): Viewer {
  return { ...viewer, support: SUPPORT_SESSION };
}
