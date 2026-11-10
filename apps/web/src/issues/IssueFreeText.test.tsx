import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import "../i18n";
import { IssueDescription, IssueLocation } from "./IssueFreeText";

/**
 * How a location reads once the issue's free text is gone (ADR 0057): as
 * removed with the free text, naming neither a cause nor a place.
 */

describe("the location of an issue", () => {
  it("says the free text was removed, and when, once it is gone", () => {
    render(
      <IssueLocation
        issue={{
          location: null,
          locationRedactedAt: null,
          freeTextRemovedAt: "2026-11-03T03:21:00.000Z",
        }}
      />,
    );

    expect(screen.getByText(/Fritexten togs bort/)).toBeTruthy();
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

    expect(screen.queryByText(/Fritexten togs bort|Borttaget/)).toBeNull();
  });
});

describe("the description of an issue", () => {
  const photo = {
    id: "photo-1",
    url: "/media/photo-1",
    fileName: "photo.jpg",
    width: null,
    height: null,
  };

  it("says the free text, the conversation and the photographs went once none stands", () => {
    render(
      <IssueDescription
        issue={{
          description: "",
          descriptionRedactedAt: null,
          freeTextRemovedAt: "2026-11-03T03:21:00.000Z",
          photos: [],
        }}
      />,
    );

    expect(screen.getByText(/Fritexten, svaren och bilderna/)).toBeTruthy();
    expect(screen.getByText("2026-11-03")).toBeTruthy();
  });

  it("claims no photograph gone while one attached during the purge stands", () => {
    render(
      <IssueDescription
        issue={{
          description: "",
          descriptionRedactedAt: null,
          freeTextRemovedAt: "2026-11-03T03:21:00.000Z",
          photos: [photo],
        }}
      />,
    );

    expect(screen.queryByText(/bilderna/)).toBeNull();
    expect(screen.getByText(/Fritexten togs bort/)).toBeTruthy();
    expect(screen.getByText("2026-11-03")).toBeTruthy();
  });
});
