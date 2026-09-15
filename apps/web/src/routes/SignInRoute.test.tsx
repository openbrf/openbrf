import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { SignInRoute } from "./SignInRoute";

/**
 * The way from the sign-in screen to the request form, and where signing in
 * lands.
 *
 * The link is offered only while the board has the form switched on. A
 * standing link to a closed door tells a resident their cooperative accepts
 * requests, sends them to a screen that says the opposite, and leaves them
 * believing the instance is broken rather than that a decision was made.
 *
 * Where a signed-in person goes next is the other half. Two things are being
 * held to here and both are easy to lose: the address somebody actually asked
 * for survives the detour through sign-in, and an authorization request an
 * external app sent them in with survives it as the same bytes.
 */

const fetchSignupState = vi.fn();
const signInWithPassword = vi.fn();
const verifySecondFactor = vi.fn();

vi.mock("../api/signup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/signup")>()),
  fetchSignupState: () => fetchSignupState(),
}));

vi.mock("../auth/sign-in-methods", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/sign-in-methods")>()),
  signInWithPassword: (input: { email: string; password: string }) =>
    signInWithPassword(input) as unknown,
  verifySecondFactor: (input: { code: string }) =>
    verifySecondFactor(input) as unknown,
}));

const navigate = vi.hoisted(() => vi.fn());
/** What the route reads out of its own declared search parameters. */
const search = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

// The screen under test is a route component; the router itself is not what
// these assertions are about.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => search.value,
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

/**
 * One as a provider composes it: signed, and naming the parameters it signed
 * once each, so the query carries the same name more than once.
 */
const REQUEST =
  "?response_type=code&client_id=https%3A%2F%2Fapp.example%2Fmetadata.json" +
  "&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&scope=mcp%3Aread+mcp%3Awrite" +
  "&exp=4102444800&ba_iat=1788999700" +
  "&ba_param=client_id&ba_param=exp&ba_param=redirect_uri" +
  "&ba_param=response_type&ba_param=scope&sig=c2lnbmF0dXJl";

const requestLink = () =>
  screen.queryByRole("link", { name: "Ansök om konto" });

/** Puts an address in the bar without the router having built it. */
function atAddress(searchString: string): void {
  window.history.replaceState(null, "", `/app/sign-in${searchString}`);
}

async function signInWithAPassword(): Promise<void> {
  const person = userEvent.setup();
  await person.type(screen.getByLabelText("E-postadress"), "anna@example.test");
  await person.type(screen.getByLabelText("Lösenord"), "ett lösenord");
  await person.click(screen.getByRole("button", { name: "Logga in" }));
}

beforeEach(() => {
  fetchSignupState.mockReset().mockResolvedValue({
    ok: true,
    value: { enabled: false },
  });
  signInWithPassword.mockReset().mockResolvedValue({ status: "signed-in" });
  verifySecondFactor.mockReset().mockResolvedValue({ status: "signed-in" });
  navigate.mockReset();
  search.value = {};
  atAddress("");
});

describe("the link to the request form", () => {
  it("is offered when the instance accepts requests", async () => {
    fetchSignupState.mockResolvedValue({ ok: true, value: { enabled: true } });

    render(<SignInRoute />);

    await waitFor(() => {
      expect(requestLink()).toBeTruthy();
    });
    expect(requestLink()).toHaveProperty(
      "href",
      expect.stringContaining("/request-account"),
    );
  });

  it("is absent when the board has the form switched off", async () => {
    fetchSignupState.mockResolvedValue({ ok: true, value: { enabled: false } });

    render(<SignInRoute />);

    await waitFor(() => {
      expect(fetchSignupState).toHaveBeenCalled();
    });
    expect(requestLink()).toBeNull();
    // The screen itself is unaffected: this is only about the extra way in.
    expect(screen.getByRole("heading", { name: "Logga in" })).toBeTruthy();
  });

  it("is absent when the instance cannot be asked", async () => {
    fetchSignupState.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });

    render(<SignInRoute />);

    await waitFor(() => {
      expect(fetchSignupState).toHaveBeenCalled();
    });
    expect(requestLink()).toBeNull();
  });
});

describe("the address somebody asked for", () => {
  it("is where signing in lands them", async () => {
    search.value = { returnTo: "/documents?shelf=styrelsen" };

    render(<SignInRoute />);
    await signInWithAPassword();

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        href: "/documents?shelf=styrelsen",
      });
    });
  });

  it("is still where the second factor lands them", async () => {
    /*
     * The failure this catches: a destination worked out only where the
     * password is checked. An account with an authenticator app never reaches
     * that branch - it is handed a code form first - so it would go to the
     * start while everybody else went where they asked.
     */
    search.value = { returnTo: "/meetings" };
    signInWithPassword.mockResolvedValue({ status: "second-factor-required" });

    render(<SignInRoute />);
    await signInWithAPassword();

    const person = userEvent.setup();
    await person.type(await screen.findByLabelText("Engångskod"), "123456");
    await person.click(
      screen.getByRole("button", { name: "Slutför inloggningen" }),
    );

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ href: "/meetings" });
    });
  });

  it("is the start when there is none", async () => {
    render(<SignInRoute />);
    await signInWithAPassword();

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ href: "/" });
    });
  });

  it.each([
    ["another host", "//evil.example"],
    ["a scheme of its own", "https://evil.example"],
    ["a backslash a browser reads as a slash", "/\\evil.example"],
    ["a stripped separator", "/\t/evil.example"],
  ])(
    "is the start when it would leave the origin: %s",
    async (_name, value) => {
      search.value = { returnTo: value };

      render(<SignInRoute />);
      await signInWithAPassword();

      await waitFor(() => {
        expect(navigate).toHaveBeenCalledWith({ href: "/" });
      });
    },
  );
});

describe("an app waiting to be told whether it may act for this person", () => {
  it("gets the consent screen, carrying its request byte for byte", async () => {
    atAddress(REQUEST);

    render(<SignInRoute />);
    await signInWithAPassword();

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        href: `/app/oauth/consent${REQUEST}`,
        reloadDocument: true,
      });
    });
  });

  it("keeps every occurrence of the parameter that repeats", async () => {
    // The one the signature is computed over and the one a rebuilt query
    // collapses. If this ever holds only one value, no consent can follow.
    atAddress(REQUEST);

    render(<SignInRoute />);
    await signInWithAPassword();

    await waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });
    const destination = navigate.mock.calls[0]?.[0] as
      { href: string } | undefined;
    const href = destination?.href ?? "";
    expect(
      new URLSearchParams(href.slice(href.indexOf("?"))).getAll("ba_param"),
    ).toEqual(["client_id", "exp", "redirect_uri", "response_type", "scope"]);
  });

  it("comes before a returnTo, which a signed request never carries", async () => {
    atAddress(REQUEST);
    search.value = { returnTo: "/documents" };

    render(<SignInRoute />);
    await signInWithAPassword();

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        href: `/app/oauth/consent${REQUEST}`,
        reloadDocument: true,
      });
    });
    expect(navigate).not.toHaveBeenCalledWith({ href: "/documents" });
  });

  it("is not read out of a query that is not a request", async () => {
    atAddress("?returnTo=%2Fdocuments");
    search.value = { returnTo: "/documents" };

    render(<SignInRoute />);
    await signInWithAPassword();

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ href: "/documents" });
    });
  });
});
