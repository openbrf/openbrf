import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
