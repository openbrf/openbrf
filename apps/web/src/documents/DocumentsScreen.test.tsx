import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { previewed } from "../api/viewer-preview";
import { asSupportSession } from "../support/support-fixtures";
import { DocumentsScreen } from "./DocumentsScreen";
import type { ArchivedDocument } from "./documents-api";

/**
 * The archive as the house reads it, and the one thing of the board's left on
 * it.
 *
 * The screen never decides who may read what: the list endpoint answers with
 * the shelf the viewer's audience allows, and these cases hold the screen to
 * showing exactly that. Filing and the audience filter are the board's page
 * (DocumentBoardScreen.test.tsx); what a board member keeps here is the edit
 * on a document they are reading, in place under the board's sign (ADR 0049).
 */

const fetchDocuments = vi.fn();

vi.mock("./documents-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./documents-api")>()),
  fetchDocuments: () => fetchDocuments(),
}));

const BYLAWS: ArchivedDocument = {
  id: "document-1",
  title: "Stadgar 2024",
  category: "Stadgar",
  audience: "PUBLIC",
  fileName: "stadgar-2024.pdf",
  contentType: "application/pdf",
  byteSize: 41_500,
  url: "/api/media/file-1",
  uploadedAt: "2026-08-29T09:00:00.000Z",
};

const BOARD_PAPERS: ArchivedDocument = {
  id: "document-3",
  title: "Styrelsens arbetsordning",
  category: "Styrelsearbete",
  audience: "BOARD",
  fileName: "arbetsordning.pdf",
  contentType: "application/pdf",
  byteSize: 30_000,
  url: "/api/media/file-3",
  uploadedAt: "2026-08-29T11:00:00.000Z",
};

const MINUTES: ArchivedDocument = {
  id: "document-2",
  title: "Protokoll stamma 2026",
  category: "Protokoll",
  audience: "MEMBER",
  fileName: "protokoll-2026.pdf",
  contentType: "application/pdf",
  byteSize: 120_000,
  url: "/api/media/file-2",
  uploadedAt: "2026-08-29T10:00:00.000Z",
};

function viewerWith(capabilities: string[]): Viewer {
  return {
    personId: "person-1",
    firstName: "Anna",
    lastName: "Andersson",
    preferredLocale: "sv",
    capabilities,
    housingCooperative: {
      name: "Brf Eksemplet",
      primaryColor: null,
      logoUrl: null,
      logoDarkUrl: null,
    },
  };
}

function renderScreen(capabilities: string[] = []) {
  return render(<DocumentsScreen viewer={viewerWith(capabilities)} />);
}

const filePanel = () =>
  screen.queryByRole("heading", { name: "Lägg in ett dokument" });

beforeEach(() => {
  fetchDocuments
    .mockReset()
    .mockResolvedValue({ ok: true, value: [BYLAWS, MINUTES] });
});

describe("a member reading the archive", () => {
  it("sees the shelf the server sent, grouped by binder", async () => {
    renderScreen();

    expect(
      await screen.findByRole("heading", { name: "Stadgar" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Protokoll" })).toBeTruthy();

    const link = screen.getByRole("link", { name: "Öppna Stadgar 2024" });
    // Straight at the media route: the file's own visibility is what decides
    // whether it comes back, and this screen has no other way to open one.
    expect(link.getAttribute("href")).toBe("/api/media/file-1");
    expect(screen.getByText("stadgar-2024.pdf, 41 kB")).toBeTruthy();
  });

  it("is offered nothing that changes the archive", async () => {
    renderScreen();

    await screen.findByRole("heading", { name: "Stadgar" });
    expect(filePanel()).toBeNull();
    expect(screen.queryByRole("button", { name: "Ändra" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Visa" })).toBeNull();
  });

  it("says the archive holds nothing for them rather than that it is empty", async () => {
    fetchDocuments.mockResolvedValue({ ok: true, value: [] });
    renderScreen();

    expect(
      await screen.findByText(
        "Här finns ännu inget för dig. Styrelsen avgör vilka dokument som är medlemmarnas och vilka som publiceras.",
      ),
    ).toBeTruthy();
  });

  it("reports a refused or failed read rather than an empty archive", async () => {
    fetchDocuments.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    renderScreen();

    expect(
      await screen.findByText(
        "Arkivet kunde inte läsas just nu. Ladda om sidan.",
      ),
    ).toBeTruthy();
  });
});

describe("a board member reading the archive", () => {
  it("is offered the edit on the shelf, under the board's sign", async () => {
    renderScreen(["documents:manage", "residentDirectory:read"]);

    const heading = await screen.findByRole("heading", { name: "Protokoll" });
    const shelf = heading.parentElement as HTMLElement;
    const controls = within(shelf).getByRole("group", { name: "Styrelsen" });
    expect(
      within(controls).getByRole("button", { name: "Ändra" }),
    ).toBeTruthy();
  });

  it("is shown no filing, no filter and no board zone: those are the board's page", async () => {
    renderScreen(["documents:manage", "residentDirectory:read"]);

    await screen.findByRole("heading", { name: "Stadgar" });
    expect(filePanel()).toBeNull();
    expect(screen.queryByRole("group", { name: "Visa" })).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: /Hantera arkivet/ }),
    ).toBeNull();
  });

  it("is told the archive is empty rather than empty for them", async () => {
    fetchDocuments.mockResolvedValue({ ok: true, value: [] });
    renderScreen(["documents:manage", "residentDirectory:read"]);

    expect(await screen.findByText("Arkivet är ännu tomt.")).toBeTruthy();
  });
});

describe("a support session", () => {
  it("reads the shelves and is offered nothing that changes them", async () => {
    render(
      <DocumentsScreen
        viewer={asSupportSession(viewerWith(["documents:manage"]))}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Protokoll" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ändra" })).toBeNull();
    expect(filePanel()).toBeNull();
  });
});

describe("the board's resident preview", () => {
  const BOARD = ["documents:manage", "self:manage", "issues:report"];

  beforeEach(() => {
    // What the server sends the board member, whatever the preview says.
    fetchDocuments.mockResolvedValue({
      ok: true,
      value: [BYLAWS, MINUTES, BOARD_PAPERS],
    });
  });

  it("leaves the board's shelf, its binders, links and signs out, and puts them back on stopping", async () => {
    const { rerender } = render(
      <DocumentsScreen viewer={previewed(viewerWith(BOARD))} />,
    );

    await screen.findByRole("heading", { name: "Stadgar" });
    expect(screen.getByRole("heading", { name: "Protokoll" })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Styrelsearbete" }),
    ).toBeNull();
    expect(screen.queryByText("Styrelsens arbetsordning")).toBeNull();
    expect(screen.queryByRole("link", { name: /arbetsordning/i })).toBeNull();
    expect(screen.queryByText("arbetsordning.pdf, 30 kB")).toBeNull();
    // Nothing of the board's: no panel, no change.
    expect(filePanel()).toBeNull();
    expect(screen.queryByRole("button", { name: "Ändra" })).toBeNull();

    // Stopped: the screen is mounted again with the board's own viewer.
    rerender(<DocumentsScreen viewer={viewerWith(BOARD)} />);
    expect(
      await screen.findByRole("heading", { name: "Styrelsearbete" }),
    ).toBeTruthy();
    expect(screen.getByText("Styrelsens arbetsordning")).toBeTruthy();
    // The audience filter is the board's page, not this screen.
    expect(screen.queryByRole("group", { name: /visa$/i })).toBeNull();
  });

  it("says the archive holds nothing for them when the board's shelf was all there was", async () => {
    fetchDocuments.mockResolvedValue({ ok: true, value: [BOARD_PAPERS] });
    render(<DocumentsScreen viewer={previewed(viewerWith(BOARD))} />);

    expect(
      await screen.findByText(
        "Här finns ännu inget för dig. Styrelsen avgör vilka dokument som är medlemmarnas och vilka som publiceras.",
      ),
    ).toBeTruthy();
  });
});
