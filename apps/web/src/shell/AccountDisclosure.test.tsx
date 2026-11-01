import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { AccountDisclosure } from "./AccountDisclosure";

/** The router's location, as the mock below answers it. */
const location = vi.hoisted(() => ({ pathname: "/" }));

/** The router's Link, as an anchor that reports its press. */
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
    onClick,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
    onClick?: () => void;
  }): ReactElement => (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      {children}
    </a>
  ),
  useLocation: ({
    select,
  }: {
    select: (value: { pathname: string }) => string;
  }): string => select({ pathname: location.pathname }),
}));

/* Names held in constants so the no-literal-string rule stays strict. */
const NAME = "Anna Lindqvist";
const OUTSIDE = "Elsewhere";

function renderDisclosure(
  props: Partial<Parameters<typeof AccountDisclosure>[0]> = {},
): void {
  render(
    <>
      <button type="button">{OUTSIDE}</button>
      <AccountDisclosure
        name={NAME}
        role={undefined}
        pathname={location.pathname}
        onSignOut={vi.fn()}
        signingOut={false}
        {...props}
      />
    </>,
  );
}

const trigger = (name: string | RegExp = NAME) =>
  screen.getByRole("button", { name });

/** The panel the trigger controls, which is there only while it is open. */
function panel(): HTMLElement {
  const id = trigger().getAttribute("aria-controls");
  const element = id === null ? null : document.getElementById(id);
  if (element === null) {
    throw new Error("the panel is not open");
  }
  return element;
}

/** What the open panel holds, in its order. */
const items = () =>
  within(panel())
    .getAllByRole("listitem")
    .map((item) => item.textContent);

afterEach(() => {
  location.pathname = "/";
});

describe("AccountDisclosure", () => {
  it("is a button under the person's name that says whether it is open", () => {
    renderDisclosure();

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().hasAttribute("aria-controls")).toBe(false);

    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(panel().tagName).toBe("UL");
  });

  it("holds the person's settings and signing out, in that order", () => {
    renderDisclosure();
    fireEvent.click(trigger());

    expect(items()).toEqual(["Dina inställningar", "Logga ut"]);
    expect(
      within(panel())
        .getByRole("link", { name: "Dina inställningar" })
        .getAttribute("href"),
    ).toBe("/settings");
  });

  it("puts the resident preview between them where it is offered", () => {
    renderDisclosure({ onStartPreview: vi.fn() });
    fireEvent.click(trigger());

    expect(items()).toEqual([
      "Dina inställningar",
      "Visa som boende",
      "Logga ut",
    ]);
  });

  it("offers no sign-out where the caller does not handle it", () => {
    renderDisclosure({ onSignOut: undefined });
    fireEvent.click(trigger());

    expect(items()).toEqual(["Dina inställningar"]);
  });

  it("says the role under the name during a support session", () => {
    renderDisclosure({
      name: "Kim at the host",
      role: "Support, endast läsning",
    });

    // Both are the trigger's name, so a screen reader hears whose panel it is.
    expect(trigger("Kim at the host Support, endast läsning")).toBeTruthy();
  });

  it.each([
    ["is not known yet", undefined],
    ["is nothing but spaces", "   "],
  ])("names the account when the person's name %s", (_case, name) => {
    renderDisclosure({ name });
    expect(trigger("Ditt konto")).toBeTruthy();
  });

  it("is shown at every width, its name truncated rather than hidden", () => {
    renderDisclosure();

    // Below 1024px the band holds no navigation, and on a phone this is the
    // only way to the person's settings and to signing out.
    let element: HTMLElement | null = trigger();
    while (element !== null) {
      expect(element.className.split(" ")).not.toContain("hidden");
      expect(element.className).not.toMatch(/\b(sm|md|lg|xl):hidden\b/u);
      element = element.parentElement;
    }
    expect(screen.getByText(NAME).className).toContain("truncate");
  });

  it("opens from the keyboard, walks in order and closes on Escape back to its trigger", async () => {
    const user = userEvent.setup();
    renderDisclosure({ onStartPreview: vi.fn() });

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(trigger());

    await user.keyboard("{Enter}");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Dina inställningar");
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Visa som boende");
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Logga ut");

    await user.keyboard("{Escape}");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());

    await user.keyboard(" ");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes when focus leaves it, and on a press outside", async () => {
    const user = userEvent.setup();
    renderDisclosure();

    fireEvent.click(trigger());
    await user.click(screen.getByRole("button", { name: OUTSIDE }));
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    trigger().focus();
    await user.keyboard("{Enter}");
    await user.tab({ shift: true });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes after each choice, and does what was chosen", () => {
    const onStartPreview = vi.fn();
    const onSignOut = vi.fn();
    renderDisclosure({ onStartPreview, onSignOut });

    for (const [role, name] of [
      ["link", "Dina inställningar"],
      ["button", "Visa som boende"],
      ["button", "Logga ut"],
    ] as const) {
      fireEvent.click(trigger());
      fireEvent.click(within(panel()).getByRole(role, { name }));
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    }
    expect(onStartPreview).toHaveBeenCalledTimes(1);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("holds sign-out back while one is waiting for its answer", () => {
    renderDisclosure({ signingOut: true });
    fireEvent.click(trigger());

    const signOut = within(panel()).getByRole("button", { name: "Logga ut" });
    expect((signOut as HTMLButtonElement).disabled).toBe(true);
  });

  it("marks itself as where you are on the person's own settings", () => {
    location.pathname = "/settings";
    renderDisclosure();

    // More than colour: the sign's 3px brass underline, and aria-current.
    expect(trigger().getAttribute("aria-current")).toBe("true");
    expect(trigger().className).toContain("border-trust-register");
    fireEvent.click(trigger());
    expect(
      within(panel()).getByRole("link", { name: "Dina inställningar" })
        .className,
    ).toContain("border-trust-register");
  });

  it("leaves itself unmarked anywhere else", () => {
    location.pathname = "/board/settings";
    renderDisclosure();
    expect(trigger().hasAttribute("aria-current")).toBe(false);
    expect(trigger().className).not.toContain("border-trust-register");
  });
});
