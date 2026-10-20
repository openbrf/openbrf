import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";

const getSession = vi.fn();
const fetchViewer = vi.fn();

vi.mock("../auth/auth-client", () => ({
  authClient: { getSession: () => getSession() },
}));

/*
 * A signed-out visitor is asked of the viewer endpoint too, which answers a
 * support session (ADR 0028). It refuses anybody else, which is what it says
 * unless a test says otherwise.
 */
vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchViewer: () => fetchViewer(),
}));

beforeEach(() => {
  fetchViewer.mockReset().mockResolvedValue({
    ok: false,
    failure: { status: 401, reason: "unexpected" },
  });
});

const { router } = await import("./router");

/**
 * The sign-in screen's guard, for somebody whose session is already there:
 * they followed a link that sent them to sign in, in a tab that turned out to
 * be signed in all along.
 */
describe("the sign-in screen for somebody already signed in", () => {
  beforeEach(() => {
    getSession.mockResolvedValue({ data: { session: {}, user: {} } });
  });

  it("goes on to the address the link asked for", async () => {
    await router.navigate({
      href: "/sign-in?returnTo=%2Fdocuments%3Fshelf%3Dstyrelsen",
    });

    expect(router.state.location.href).toBe("/documents?shelf=styrelsen");
  });

  it("goes to the start when that address leaves the application", async () => {
    await router.navigate({ href: "/sign-in?returnTo=%2F%2Fevil.example" });

    expect(router.state.location.pathname).toBe("/");
  });

  it.each([
    // `/%2e%2e/%2e%2e//evil.example` once the query is read: a traversal the
    // URL parser collapses to `//evil.example`.
    "%2F%252e%252e%2F%252e%252e%2F%2Fevil.example",
    // `/%2f%2fevil.example`, which is `///evil.example` one decode later.
    "%2F%252f%252fevil.example",
  ])(
    "goes to the start when that address leaves once it is decoded: %s",
    async (returnTo) => {
      await router.navigate({ href: `/sign-in?returnTo=${returnTo}` });

      expect(router.state.location.pathname).toBe("/");
    },
  );
});

/**
 * Where the chat used to be. Its rooms became the feed's audiences, and a
 * bookmark or a link in an old email still lands on the feed.
 */
describe("the chat's old address", () => {
  beforeEach(() => {
    getSession.mockResolvedValue({ data: { session: {}, user: {} } });
  });

  it("goes on to the feed", async () => {
    await router.navigate({ href: "/chat" });

    expect(router.state.location.pathname).toBe("/feed");
  });

  it("leaves a post's own address under the feed, with the post named", async () => {
    await router.navigate({ href: "/feed/post-1" });

    expect(router.state.location.pathname).toBe("/feed/post-1");
    expect(router.state.matches.at(-1)?.params).toEqual({ postId: "post-1" });
  });
});

/**
 * The settings sections, which are routes under one parent route: the parent
 * stays mounted while the reader moves between them, which is what keeps the
 * screen's read of the instance from being made again for each section.
 */
describe("the settings sections", () => {
  beforeEach(() => {
    getSession.mockResolvedValue({ data: { session: {}, user: {} } });
  });

  it("are each an address of their own under the settings route", async () => {
    await router.navigate({ href: "/settings/communication" });

    expect(router.state.location.pathname).toBe("/settings/communication");
    const routeIds = router.state.matches.map((match) => match.routeId);
    expect(routeIds).toContain("/settings");
    expect(routeIds).toContain("/settings/$section");
    expect(router.state.matches.at(-1)?.params).toMatchObject({
      section: "communication",
    });
  });

  it("leave /settings itself to the screen, which knows the viewer", async () => {
    await router.navigate({ href: "/settings" });

    expect(router.state.location.pathname).toBe("/settings");
    expect(router.state.matches.map((match) => match.routeId)).toContain(
      "/settings",
    );
  });

  it("send somebody signed out to sign in, and back to the section after", async () => {
    getSession.mockResolvedValue({ data: null });

    await router.navigate({ href: "/settings/meetings" });

    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toMatchObject({
      returnTo: "/settings/meetings",
    });
  });
});

/**
 * A support session (ADR 0028), which the sign-in library knows nothing of:
 * it is a session to the routes all the same.
 */
describe("a support session", () => {
  it("opens a screen that needs a session", async () => {
    getSession.mockResolvedValue({ data: null });
    fetchViewer.mockResolvedValue({
      ok: true,
      value: {
        support: { supporter: "Kim", endsAt: "2026-10-20T20:00:00.000Z" },
      },
    });

    await router.navigate({ href: "/settings/meetings" });

    expect(router.state.location.pathname).toBe("/settings/meetings");
  });

  it("lands without a session on the page its link opens", async () => {
    getSession.mockResolvedValue({ data: null });

    await router.navigate({ href: "/support" });

    expect(router.state.matches.at(-1)?.routeId).toBe("/support");
  });
});

/**
 * Where the overview and the address book live: the overview at the start,
 * which is where every sign-in lands, and the address book at an address of
 * its own.
 */
describe("the start and the address book", () => {
  const routeAt = async (href: string): Promise<string | undefined> => {
    await router.navigate({ href });
    return router.state.matches.at(-1)?.routeId;
  };

  it("serves the overview at the start for somebody signed in", async () => {
    getSession.mockResolvedValue({ data: { session: {}, user: {} } });

    expect(await routeAt("/")).toBe("/");
  });

  it("serves the address book at /address-book", async () => {
    getSession.mockResolvedValue({ data: { session: {}, user: {} } });

    expect(await routeAt("/address-book")).toBe("/address-book");
    expect(router.state.location.pathname).toBe("/address-book");
  });

  it("sends somebody signed out to sign in, and back to the address book after", async () => {
    getSession.mockResolvedValue({ data: null });

    await router.navigate({ href: "/address-book" });

    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toEqual({
      returnTo: "/address-book",
    });
  });
});
