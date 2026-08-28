import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { PluginViewRoute } from "./PluginViewRoute";

/**
 * A plugin's own screen, and what it says when it cannot show one.
 *
 * Two outcomes look identical from inside this component and mean opposite
 * things to whoever is reading it. "There is no such view" is settled: the
 * plugin is not on this instance, or it is not offered to this account, and
 * there is nothing to try again. A read that failed says nothing about either,
 * and the useful action is to retry - so reporting a failed request as "no
 * such view" tells a resident their access is the problem when the server
 * simply did not answer.
 */

const fetchViewer = vi.fn();
const fetchPluginViews = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchViewer: () => fetchViewer(),
}));

vi.mock("../plugins/plugin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-api")>()),
  fetchPluginViews: () => fetchPluginViews(),
}));

// The remote bundle lives on the data volume, not in this build.
vi.mock("../plugins/plugin-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-i18n")>()),
  loadPluginTranslations: () => Promise.resolve(undefined),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ pluginId: "grannsamverkan" }),
  // The shell renders the navigation band around whatever this route shows.
  Link: ({
    to,
    children,
  }: {
    to: string;
    children: ReactNode;
  }): ReactElement => <a href={to}>{children}</a>,
}));

const VIEWER = {
  personId: "person-1",
  firstName: "Anna",
  lastName: "Andersson",
  preferredLocale: "sv",
  capabilities: ["self:manage"],
  housingCooperative: {
    name: "Brf Eksemplet",
    primaryColor: null,
    logoPath: null,
  },
};

const notFoundNotice = () =>
  screen.queryByText(
    "Det finns ingen vy som heter grannsamverkan på den här instansen, eller så erbjuds ditt konto den inte.",
  );
const failureNotice = () =>
  screen.queryByText("Det gick inte just nu. Försök igen.");

beforeEach(() => {
  fetchViewer.mockReset().mockResolvedValue({ ok: true, value: VIEWER });
  fetchPluginViews.mockReset();
});

describe("a view this instance does not offer", () => {
  it("says there is no such view", async () => {
    fetchPluginViews.mockResolvedValue({ ok: true, value: { views: [] } });

    render(<PluginViewRoute />);

    await waitFor(() => {
      expect(notFoundNotice()).toBeTruthy();
    });
    expect(failureNotice()).toBeNull();
  });
});

describe("a view list that could not be read", () => {
  it("does not report the failure as there being no such view", async () => {
    fetchPluginViews.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<PluginViewRoute />);

    await waitFor(() => {
      expect(failureNotice()).toBeTruthy();
    });
    expect(notFoundNotice()).toBeNull();
  });
});
