import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";

const getSession = vi.fn();

vi.mock("../auth/auth-client", () => ({
  authClient: { getSession: () => getSession() },
}));

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
