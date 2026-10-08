import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { PluginView } from "./PluginView";

/**
 * A plugin's view is fetched from its own bundle at runtime, so it can be
 * broken in ways a bundled component cannot. Whatever it does, the screen it
 * is a part of stays up (ADR 0003).
 */

const loadPluginView = vi.hoisted(() => vi.fn());

vi.mock("./plugin-i18n", () => ({
  loadPluginTranslations: () => Promise.resolve(),
}));

vi.mock("./plugin-remotes", () => ({
  loadPluginView: (view: unknown) =>
    loadPluginView(view) as Promise<ComponentType | null>,
}));

const HEADING = "Rest of the screen";

const VIEW = {
  id: "grannsamverkan",
  titleKey: "grannsamverkan.title",
  module: "./View",
  remoteEntry: "/api/plugins/grannsamverkan/client/remoteEntry.js",
};

beforeEach(() => {
  loadPluginView.mockReset();
  // React reports a caught render error on the console; that is expected here.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PluginView", () => {
  it("shows a notice in place of a view that throws while rendering", async () => {
    loadPluginView.mockResolvedValue(() => {
      throw new Error("stale bundle");
    });

    render(
      <main>
        <h1>{HEADING}</h1>
        <PluginView view={VIEW} />
      </main>,
    );

    expect(
      await screen.findByText(
        "Vyn från grannsamverkan kunde inte läsas in. Resten av sidan fungerar fortfarande.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: HEADING })).toBeTruthy();
  });
});
