import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { SupportAccessOverview, SupportAccessView } from "../api/support";
import i18n from "../i18n";
import { formatMoment } from "../ui/moment";
import { SupportAccessPanel } from "./SupportAccessPanel";

/**
 * Opening and closing support access from the settings (ADR 0028).
 *
 * The form says the reason is kept for good before it is sent, offers the five
 * durations and nothing else, and is not there at all for a viewer who may
 * only read; an open access shows who may be looking and offers the close.
 */

const fetchSupportAccess = vi.fn();
const openSupportAccess = vi.fn();
const closeSupportAccess = vi.fn();

vi.mock("../api/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/support")>()),
  fetchSupportAccess: () => fetchSupportAccess(),
  openSupportAccess: (input: unknown) => openSupportAccess(input),
  closeSupportAccess: (id: string) => closeSupportAccess(id),
}));

const OPEN: SupportAccessView = {
  id: "access-1",
  state: "open",
  openedAt: "2026-10-20T08:00:00.000Z",
  openedBy: { personId: "admin-1", name: "Astrid Admin" },
  endsAt: "2026-10-20T16:00:00.000Z",
  closedAt: null,
  closedBy: null,
  sessions: [
    {
      id: "session-1",
      supporter: "Kim at the host",
      issuedAt: "2026-10-20T08:05:00.000Z",
      startedAt: "2026-10-20T08:06:00.000Z",
      expiresAt: "2026-10-20T16:00:00.000Z",
      endedAt: null,
    },
  ],
};

const LAPSED: SupportAccessView = {
  ...OPEN,
  id: "access-0",
  state: "lapsed",
  sessions: [],
};

function overview(value: SupportAccessOverview): void {
  fetchSupportAccess.mockResolvedValue({ ok: true, value });
}

beforeEach(() => {
  fetchSupportAccess.mockReset();
  openSupportAccess.mockReset().mockResolvedValue({ ok: true, value: OPEN });
  closeSupportAccess
    .mockReset()
    .mockResolvedValue({ ok: true, value: undefined });
});

describe("with no access open", () => {
  it("opens one for the hours chosen with the reason given, trimmed", async () => {
    overview({ open: null, accesses: [] });
    render(<SupportAccessPanel editable />);

    const hours = await screen.findByLabelText("Öppen i");
    expect(
      [...(hours as HTMLSelectElement).options].map((option) => option.value),
    ).toEqual(["1", "8", "24", "72", "168"]);
    fireEvent.change(hours, { target: { value: "72" } });
    await userEvent.type(
      screen.getByLabelText(/Anledning/),
      "  Invitations are not arriving.  ",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Öppna supportåtkomst" }),
    );

    await waitFor(() => {
      expect(openSupportAccess).toHaveBeenCalledWith({
        hours: 72,
        reason: "Invitations are not arriving.",
      });
    });
    // Read again, so the panel shows what was opened.
    expect(fetchSupportAccess).toHaveBeenCalledTimes(2);
  });

  it("says the reason is kept for good before it is sent", async () => {
    overview({ open: null, accesses: [] });
    render(<SupportAccessPanel editable />);

    expect(await screen.findByText(/sparas där för alltid/)).toBeTruthy();
  });

  it("does not send a blank reason", async () => {
    overview({ open: null, accesses: [] });
    render(<SupportAccessPanel editable />);

    const open = await screen.findByRole("button", {
      name: "Öppna supportåtkomst",
    });
    await userEvent.type(screen.getByLabelText(/Anledning/), "   ");

    expect((open as HTMLButtonElement).disabled).toBe(true);
    expect(openSupportAccess).not.toHaveBeenCalled();
  });

  it("names the refusal when another administrator opened one first", async () => {
    overview({ open: null, accesses: [] });
    openSupportAccess.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "support-access-open" },
    });
    render(<SupportAccessPanel editable />);

    await userEvent.type(await screen.findByLabelText(/Anledning/), "Why.");
    await userEvent.click(
      screen.getByRole("button", { name: "Öppna supportåtkomst" }),
    );

    expect(
      await screen.findByText(/Supportåtkomst är redan öppen/),
    ).toBeTruthy();
  });

  it("offers no form to a viewer who may only read", async () => {
    overview({ open: null, accesses: [] });
    render(<SupportAccessPanel editable={false} />);

    expect(
      await screen.findByText("Ingen supportåtkomst är öppen."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText(/Anledning/)).toBeNull();
  });
});

describe("with an access open", () => {
  it("shows who opened it, who signed in, and offers the close", async () => {
    overview({ open: OPEN, accesses: [OPEN, LAPSED] });
    render(<SupportAccessPanel editable />);

    expect(await screen.findByText(/Öppnad av Astrid Admin/)).toBeTruthy();
    expect(screen.getAllByText("Kim at the host")).toHaveLength(1);
    expect(screen.getByText("Förfallen")).toBeTruthy();
    expect(screen.queryByLabelText(/Anledning/)).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Stäng supportåtkomst" }),
    );

    await waitFor(() => {
      expect(closeSupportAccess).toHaveBeenCalledWith("access-1");
    });
  });

  it("offers no close to a viewer who may only read", async () => {
    overview({ open: OPEN, accesses: [OPEN] });
    render(<SupportAccessPanel editable={false} />);

    expect(await screen.findByText(/Öppnad av Astrid Admin/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("timestamps", () => {
  const inDataFace = (iso: string, locale = "sv"): HTMLElement =>
    screen.getByText(formatMoment(iso, locale));

  afterEach(async () => {
    await i18n.changeLanguage("sv");
  });

  const CLOSED: SupportAccessView = {
    ...OPEN,
    id: "access-2",
    state: "closed",
    openedAt: "2026-10-18T08:00:00.000Z",
    endsAt: "2026-10-18T16:00:00.000Z",
    closedAt: "2026-10-18T09:30:00.000Z",
    closedBy: { personId: "admin-1", name: "Astrid Admin" },
    sessions: [
      {
        id: "session-2",
        supporter: "Sam at the host",
        issuedAt: "2026-10-18T08:05:00.000Z",
        startedAt: "2026-10-18T08:06:00.000Z",
        expiresAt: "2026-10-18T16:00:00.000Z",
        endedAt: "2026-10-18T09:00:00.000Z",
      },
      {
        id: "session-3",
        supporter: "Robin at the host",
        issuedAt: "2026-10-18T08:10:00.000Z",
        startedAt: null,
        expiresAt: "2026-10-18T16:00:00.000Z",
        endedAt: null,
      },
    ],
  };
  const ENDED: SupportAccessView = {
    ...CLOSED,
    id: "access-3",
    state: "ended",
    openedAt: "2026-10-17T08:00:00.000Z",
    endsAt: "2026-10-17T16:00:00.000Z",
    closedAt: null,
    closedBy: null,
    sessions: [],
  };
  const LAPSED_EARLIER: SupportAccessView = {
    ...ENDED,
    id: "access-4",
    state: "lapsed",
    openedAt: "2026-10-16T08:00:00.000Z",
    endsAt: "2026-10-16T16:00:00.000Z",
  };

  it("sets the open access and a signed-in session in the data face", async () => {
    overview({ open: OPEN, accesses: [OPEN] });
    render(<SupportAccessPanel editable />);
    await screen.findByText(/Öppnad av Astrid Admin/);

    expect(inDataFace(OPEN.endsAt).className).toContain("font-data");
    expect(inDataFace(OPEN.openedAt).className).toContain("font-data");
    expect(inDataFace(OPEN.sessions[0]?.startedAt ?? "").className).toContain(
      "font-data",
    );
    // The sentence around the times stays in the UI face.
    expect(screen.getByText(/Öppnad av Astrid Admin/).className).not.toContain(
      "font-data",
    );
  });

  it("sets every time in the history in the data face", async () => {
    overview({ open: null, accesses: [CLOSED, ENDED, LAPSED_EARLIER] });
    render(<SupportAccessPanel editable />);
    await screen.findByText(/Stängd av Astrid Admin/);

    for (const iso of [
      CLOSED.openedAt,
      CLOSED.closedAt ?? "",
      CLOSED.sessions[0]?.startedAt ?? "",
      CLOSED.sessions[0]?.endedAt ?? "",
      CLOSED.sessions[1]?.issuedAt ?? "",
      ENDED.endsAt,
      LAPSED_EARLIER.endsAt,
    ]) {
      expect(inDataFace(iso).className).toContain("font-data");
    }
  });

  it("keeps the English sentences around the data face times", async () => {
    await i18n.changeLanguage("en");
    overview({ open: OPEN, accesses: [OPEN, CLOSED] });
    render(<SupportAccessPanel editable />);

    const sentence = await screen.findByText(/Open until/);
    expect(sentence.textContent).toBe(
      `Open until ${formatMoment(OPEN.endsAt, "en")}. Opened by Astrid Admin on ${formatMoment(OPEN.openedAt, "en")}.`,
    );
    expect(inDataFace(OPEN.endsAt, "en").className).toContain("font-data");
    expect(screen.getByText(/Closed by Astrid Admin on/).textContent).toBe(
      `Closed by Astrid Admin on ${formatMoment(CLOSED.closedAt ?? "", "en")}.`,
    );
    expect(
      inDataFace(CLOSED.sessions[0]?.endedAt ?? "", "en").className,
    ).toContain("font-data");
  });
});

describe("names that look like markup", () => {
  afterEach(async () => {
    await i18n.changeLanguage("sv");
  });

  // A name is free text the administrator's register or the host supplied: a
  // closing tag must not end the sentence early, and a tag must not become one.
  const NAMES = ["Kim </0>", "Kim <br/> Host", "Kim <data>Host</data>"];
  const SENTENCES = {
    sv: {
      openUntil: (endsAt: string, name: string, openedAt: string) =>
        `Öppen till ${endsAt}. Öppnad av ${name} ${openedAt}.`,
      openedBy: (name: string, openedAt: string) =>
        `öppnad av ${name} ${openedAt}`,
      closedBy: (name: string, closedAt: string) =>
        `Stängd av ${name} ${closedAt}.`,
    },
    en: {
      openUntil: (endsAt: string, name: string, openedAt: string) =>
        `Open until ${endsAt}. Opened by ${name} on ${openedAt}.`,
      openedBy: (name: string, openedAt: string) =>
        `opened by ${name} on ${openedAt}`,
      closedBy: (name: string, closedAt: string) =>
        `Closed by ${name} on ${closedAt}.`,
    },
  };
  const dataFace = (element: HTMLElement): (string | null)[] =>
    [...element.querySelectorAll(".font-data")].map((span) => span.textContent);

  for (const locale of ["sv", "en"] as const) {
    for (const name of NAMES) {
      it(`keeps ${JSON.stringify(name)} literal in the ${locale} sentences`, async () => {
        await i18n.changeLanguage(locale);
        const person = { personId: "admin-1", name };
        const open: SupportAccessView = { ...OPEN, openedBy: person };
        const closed: SupportAccessView = {
          ...OPEN,
          id: "access-5",
          state: "closed",
          openedAt: "2026-10-18T08:00:00.000Z",
          endsAt: "2026-10-18T16:00:00.000Z",
          closedAt: "2026-10-18T09:30:00.000Z",
          openedBy: person,
          closedBy: person,
          sessions: [],
        };
        overview({ open, accesses: [open, closed] });
        render(<SupportAccessPanel editable />);
        const at = (iso: string): string => formatMoment(iso, locale);
        const sentences = SENTENCES[locale];

        const openUntil = (await screen.findByText(
          locale === "sv" ? /Öppen till/ : /Open until/,
        )) as HTMLElement;
        expect(openUntil.textContent).toBe(
          sentences.openUntil(at(open.endsAt), name, at(open.openedAt)),
        );
        expect(dataFace(openUntil)).toEqual([
          at(open.endsAt),
          at(open.openedAt),
        ]);

        const openedBy = screen.getByText(
          locale === "sv" ? /öppnad av/ : /opened by/,
        );
        expect(openedBy.textContent).toContain(
          sentences.openedBy(name, at(closed.openedAt)),
        );
        expect(dataFace(openedBy)).toEqual([at(closed.openedAt)]);

        const closedBy = screen.getByText(
          locale === "sv" ? /Stängd av/ : /Closed by/,
        );
        expect(closedBy.textContent).toBe(
          sentences.closedBy(name, at(closed.closedAt ?? "")),
        );
        expect(dataFace(closedBy)).toEqual([at(closed.closedAt ?? "")]);

        for (const sentence of [openUntil, openedBy, closedBy]) {
          expect(sentence.querySelector("br")).toBeNull();
        }
      });
    }
  }
});
