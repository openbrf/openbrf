import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { DisplayScreen } from "./DisplayScreen";

/**
 * The board's display screen (ADR 0050): issuing a display link, composing it
 * from the board's choices in the browser, and showing it once with a QR code.
 */

const fetchDisplayLinkOptions = vi.fn();
const issueDisplayToken = vi.fn();

vi.mock("./display-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./display-api")>()),
  fetchDisplayLinkOptions: () => fetchDisplayLinkOptions(),
  issueDisplayToken: (label: string) => issueDisplayToken(label),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: unknown }) => children,
}));

const OPTIONS = {
  ok: true,
  value: {
    resources: [
      { id: "room-a", name: "Tvättstuga A" },
      { id: "room-b", name: "Tvättstuga B" },
    ],
    defaultLocale: "sv",
  },
};

const ISSUED = {
  ok: true,
  value: {
    token: "obrf_dt_secret",
    device: {
      id: "token-1",
      label: "Port A",
      issuedAt: "2026-10-23T08:00:00.000Z",
    },
  },
};

beforeEach(() => {
  fetchDisplayLinkOptions.mockReset();
  issueDisplayToken.mockReset();
  fetchDisplayLinkOptions.mockResolvedValue(OPTIONS);
});

async function issue(session: ReturnType<typeof userEvent.setup>) {
  await session.type(
    await screen.findByLabelText(/^Var skärmen sitter/),
    "  Port A ",
  );
  await session.click(screen.getByRole("button", { name: "Utfärda länken" }));
}

describe("the display screen", () => {
  it("issues a token named by the board and shows the link once, with a QR code", async () => {
    issueDisplayToken.mockResolvedValue(ISSUED);
    const session = userEvent.setup();

    render(<DisplayScreen />);
    await issue(session);

    expect(issueDisplayToken).toHaveBeenCalledWith("Port A");
    const link = (await screen.findByLabelText(
      "Visningslänk",
    )) as HTMLTextAreaElement;
    expect(link.value).toBe(
      `${window.location.origin}/app/display#obrf_dt_secret`,
    );
    expect(
      screen.getByRole("img", { name: "QR-kod för visningslänken" }),
    ).toBeTruthy();
    // The name is the token's now, and is not changed here.
    expect(
      (screen.getByLabelText(/^Var skärmen sitter/) as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });

  it("writes the board's choices into the link, and changes it when they change", async () => {
    issueDisplayToken.mockResolvedValue(ISSUED);
    const session = userEvent.setup();

    render(<DisplayScreen />);
    await session.click(await screen.findByLabelText("Tvättstuga B"));
    await session.selectOptions(screen.getByLabelText("Färger"), "light");
    await issue(session);

    const link = (await screen.findByLabelText(
      "Visningslänk",
    )) as HTMLTextAreaElement;
    expect(link.value).toBe(
      `${window.location.origin}/app/display?resources=room-b&theme=light#obrf_dt_secret`,
    );

    await session.click(screen.getByLabelText("Nyheter"));
    await waitFor(() => {
      expect(link.value).toBe(
        `${window.location.origin}/app/display?sources=events,meeting,availability&resources=room-b&theme=light#obrf_dt_secret`,
      );
    });
    expect(issueDisplayToken).toHaveBeenCalledTimes(1);
  });

  it("issues nothing while no source is chosen", async () => {
    const session = userEvent.setup();

    render(<DisplayScreen />);
    for (const name of [
      "Nyheter",
      "Kommande evenemang",
      "Kallelse till nästa föreningsstämma",
      "Ledigt och bokat för bokningsbara resurser",
    ]) {
      await session.click(await screen.findByLabelText(name));
    }
    await session.type(screen.getByLabelText(/^Var skärmen sitter/), "Port A");

    expect(screen.getByText("Välj minst en.")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Utfärda länken",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("says why a link could not be issued", async () => {
    issueDisplayToken.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "device-token-limit" },
    });
    const session = userEvent.setup();

    render(<DisplayScreen />);
    await issue(session);

    expect(
      await screen.findByText(
        "Visningsläget har redan 200 giltiga länkar. Återkalla en på enhetssidan först.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Visningslänk")).toBeNull();
  });

  it("forgets the token when the board asks for another link", async () => {
    issueDisplayToken.mockResolvedValue(ISSUED);
    const session = userEvent.setup();

    render(<DisplayScreen />);
    await issue(session);
    await screen.findByLabelText("Visningslänk");
    await session.click(
      screen.getByRole("button", { name: "Utfärda en länk till" }),
    );

    expect(screen.queryByLabelText("Visningslänk")).toBeNull();
    expect(document.body.textContent).not.toContain("obrf_dt_secret");
  });
});
