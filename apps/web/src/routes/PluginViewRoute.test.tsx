import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { PluginBoardViewRoute, PluginViewRoute } from "./PluginViewRoute";

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

/** What the URL says, so a test can navigate from one plugin to another. */
const route = vi.hoisted(() => ({ pluginId: "grannsamverkan" }));

/** Resolved by the test, so a plugin's strings can arrive at a chosen moment. */
const loadPluginTranslations = vi.hoisted(() => vi.fn());

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
  loadPluginTranslations: (pluginId: string) =>
    loadPluginTranslations(pluginId) as Promise<void>,
}));

// The shell asks for the same list to put plugins in the navigation. That is
// the shell's own read and its own tests'; here it would take the answers each
// test queues for the route.
vi.mock("../plugins/use-plugin-nav-items", () => ({
  usePluginNavItems: () => [],
}));

// Same: the view's own module is fetched from the server at runtime.
vi.mock("../plugins/PluginView", () => ({
  PluginView: ({
    view,
  }: {
    view: { id: string; module: string };
  }): ReactElement => <p data-module={view.module}>{`view:${view.id}`}</p>,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ pluginId: route.pluginId }),
  // The shell reads the page it is on to mark where the reader is.
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string }) => string;
  }): string => select({ pathname: `/plugin/${route.pluginId}` }),
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

const notFoundNotice = (pluginId = "grannsamverkan") =>
  screen.queryByText(
    `Det finns ingen vy som heter ${pluginId} på den här instansen, eller så ` +
      "erbjuds ditt konto den inte.",
  );
const failureNotice = () =>
  screen.queryByText("Det gick inte just nu. Försök igen.");

function descriptor(id: string) {
  return {
    id,
    titleKey: "title",
    module: "./View",
    remoteEntry: `/api/plugin-assets/${id}/remoteEntry.js`,
    section: null,
    boardView: null,
  };
}

/** A plugin with a view for the residents and one for the board. */
function twoViews(id: string, offered: boolean) {
  return {
    ...descriptor(id),
    section: "building",
    boardView: { titleKey: "boardTitle", module: "./BoardView", offered },
  };
}

beforeEach(() => {
  route.pluginId = "grannsamverkan";
  fetchViewer.mockReset().mockResolvedValue({ ok: true, value: VIEWER });
  fetchPluginViews.mockReset();
  loadPluginTranslations.mockReset().mockResolvedValue(undefined);
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

  it("stops reporting it the moment another plugin is opened", async () => {
    // A read that failed says nothing about the plugin now in the URL, and the
    // window in which nothing has answered for it yet is exactly where the
    // previous answer would otherwise still be on screen.
    fetchPluginViews.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    const { rerender } = render(<PluginViewRoute />);
    await waitFor(() => {
      expect(failureNotice()).toBeTruthy();
    });

    let answer!: (result: unknown) => void;
    route.pluginId = "laddstolpar";
    fetchPluginViews.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    rerender(<PluginViewRoute />);

    // Nothing has answered for this plugin yet: the screen is loading, not
    // still showing the last one's failure.
    expect(failureNotice()).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Läser in vyn");

    await act(async () => {
      answer({ ok: true, value: { views: [] } });
    });
    expect(notFoundNotice("laddstolpar")).toBeTruthy();
    expect(failureNotice()).toBeNull();
  });
});

describe("a plugin opened while another is still being read", () => {
  it("does not show the view the earlier request was fetching", async () => {
    /*
     * A view's strings are a second trip, so the first plugin can still be
     * fetching them when the URL already names a second whose own request has
     * answered. The late one arriving must not put its view back on screen -
     * the person is looking at another plugin's page by then.
     */
    let release!: () => void;
    loadPluginTranslations.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    fetchPluginViews.mockResolvedValueOnce({
      ok: true,
      value: { views: [descriptor("grannsamverkan")] },
    });

    const { rerender } = render(<PluginViewRoute />);
    await waitFor(() => {
      expect(loadPluginTranslations).toHaveBeenCalledWith("grannsamverkan");
    });

    route.pluginId = "laddstolpar";
    fetchPluginViews.mockResolvedValueOnce({ ok: true, value: { views: [] } });
    rerender(<PluginViewRoute />);
    await waitFor(() => {
      expect(notFoundNotice("laddstolpar")).toBeTruthy();
    });

    // Flushed, so the assertion is about what the guard refused rather than
    // about React not having got round to the update yet.
    await act(async () => {
      release();
    });

    expect(screen.queryByText("view:grannsamverkan")).toBeNull();
    expect(notFoundNotice("laddstolpar")).toBeTruthy();
  });
});

/**
 * A plugin's board view (ADR 0051, amended 2026-10-26): one of the board's
 * pages, with the board's sign and its refusal, beside the residents' view it
 * belongs with and never inside it.
 */
describe("a plugin's board view", () => {
  const BOARD_NOT_OFFERED =
    "Den här sidan är styrelsens. Ditt konto har inget att göra här.";

  beforeEach(() => {
    route.pluginId = "parkering";
  });

  it("shows the board's module under the board's sign", async () => {
    fetchPluginViews.mockResolvedValue({
      ok: true,
      value: { views: [twoViews("parkering", true)] },
    });

    render(<PluginBoardViewRoute />);

    const view = await screen.findByText("view:parkering");
    expect(view.getAttribute("data-module")).toBe("./BoardView");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("Styrelsen");
    expect(heading.textContent).toContain("boardTitle");
    expect(screen.queryByText(BOARD_NOT_OFFERED)).toBeNull();
  });

  it("shows an account it is not offered to the board's refusal, and nothing of the plugin's", async () => {
    fetchPluginViews.mockResolvedValue({
      ok: true,
      value: { views: [twoViews("parkering", false)] },
    });

    render(<PluginBoardViewRoute />);

    expect(await screen.findByText(BOARD_NOT_OFFERED)).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByText("view:parkering")).toBeNull();
    // Not even the plugin's strings: the page is the core's sentence alone.
    expect(loadPluginTranslations).not.toHaveBeenCalled();
  });

  it("says there is no such view for a plugin with one view", async () => {
    fetchPluginViews.mockResolvedValue({
      ok: true,
      value: { views: [descriptor("parkering")] },
    });

    render(<PluginBoardViewRoute />);

    await waitFor(() => {
      expect(notFoundNotice("parkering")).toBeTruthy();
    });
    expect(screen.queryByText("view:parkering")).toBeNull();
  });

  it("is not the residents' view, which shows its own module and no way to the board's", async () => {
    fetchPluginViews.mockResolvedValue({
      ok: true,
      value: { views: [twoViews("parkering", true)] },
    });

    render(<PluginViewRoute />);

    const view = await screen.findByText("view:parkering");
    expect(view.getAttribute("data-module")).toBe("./View");
    expect(screen.queryByText("Styrelsen", { exact: true })).toBeNull();
    expect(
      screen
        .queryAllByRole("link")
        .some((link) =>
          link.getAttribute("href")?.startsWith("/board/plugin/"),
        ),
    ).toBe(false);
  });
});
