import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import "../i18n";
import { IssueLocation } from "./IssueFreeText";

/**
 * How a location reads once the purge has removed the issue's free text
 * (ADR 0057): as removed, and not as a place nobody gave.
 */

describe("the location of an issue", () => {
  it("says it was removed under the retention rule once the free text is gone", () => {
    render(
      <IssueLocation
        issue={{
          location: null,
          locationRedactedAt: null,
          freeTextRemovedAt: "2026-11-03T03:21:00.000Z",
        }}
      />,
    );

    expect(screen.getByText(/Gallrat enligt regeln för gallring/)).toBeTruthy();
    expect(screen.getByText("2026-11-03")).toBeTruthy();
    expect(screen.queryByText(/Ingen plats/)).toBeNull();
  });

  it("says a handler removed it when one did", () => {
    render(
      <IssueLocation
        issue={{
          location: null,
          locationRedactedAt: "2026-10-02T09:00:00.000Z",
          freeTextRemovedAt: null,
        }}
      />,
    );

    expect(screen.getByText(/Borttaget av en handläggare/)).toBeTruthy();
  });

  it("says no place was given when none was and nothing was removed", () => {
    render(
      <IssueLocation
        issue={{
          location: null,
          locationRedactedAt: null,
          freeTextRemovedAt: null,
        }}
      />,
    );

    expect(screen.queryByText(/Gallrat|Borttaget/)).toBeNull();
  });
});
