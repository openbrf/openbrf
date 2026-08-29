import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import { DocumentsScreen } from "./DocumentsScreen";
import type { ArchivedDocument } from "./documents-api";

/**
 * What each viewer is offered, and what filing a document actually sends.
 *
 * The screen never decides who may read what: the list endpoint answers with
 * the shelf the viewer's audience allows, and these cases hold the screen to
 * showing exactly that. What is tested here instead is the publication
 * guardrail the interface owns - minutes go to the members, and putting a set
 * of them on the public shelf is a second, deliberate answer.
 */

const fetchDocuments = vi.fn();
const fileDocument = vi.fn();

vi.mock("./documents-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./documents-api")>()),
  fetchDocuments: () => fetchDocuments(),
  fileDocument: (fields: unknown, file: unknown) => fileDocument(fields, file),
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

/**
 * The two radio groups on the screen offer the same three words.
 *
 * The filter names an audience to read by and the field names the audience a
 * document is given, so a query that did not say which it meant would pass
 * against either. Both are addressed through their own group.
 */
const audienceField = () =>
  screen.getAllByRole("group", { name: /vem det är till för/i })[0] as
    HTMLElement | undefined;
const audienceFilter = () => screen.getByRole("group", { name: /^visa$/i });

beforeEach(() => {
  fetchDocuments
    .mockReset()
    .mockResolvedValue({ ok: true, value: [BYLAWS, MINUTES] });
  fileDocument.mockReset().mockResolvedValue({ ok: true, value: BYLAWS });
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
    // The filter is a board's reading aid over its own three audiences.
    expect(screen.queryByRole("group", { name: /^visa$/i })).toBeNull();
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

describe("the board filing a document", () => {
  it("sends the title, the binder and the audience with the file", async () => {
    const session = userEvent.setup();
    renderScreen(["documents:manage"]);

    await screen.findByRole("heading", { name: "Stadgar" });

    await session.type(screen.getByLabelText(/^Titel/), "Stadgar 2024");
    await session.type(screen.getByLabelText(/^Pärm/), "Stadgar");
    await session.click(
      within(audienceField() as HTMLElement).getByRole("radio", {
        name: /publicerat/i,
      }),
    );
    await session.upload(
      screen.getByLabelText("Fil"),
      new File(["%PDF-1.7"], "stadgar.pdf", { type: "application/pdf" }),
    );
    await session.click(
      screen.getByRole("button", { name: "Lägg in dokumentet" }),
    );

    await waitFor(() => {
      expect(fileDocument).toHaveBeenCalledTimes(1);
    });
    expect(fileDocument.mock.calls[0]?.[0]).toEqual({
      title: "Stadgar 2024",
      category: "Stadgar",
      audience: "PUBLIC",
    });
  });

  it("takes minutes off the public shelf and says why", async () => {
    const session = userEvent.setup();
    renderScreen(["documents:manage"]);

    await screen.findByRole("heading", { name: "Stadgar" });

    await session.click(
      within(audienceField() as HTMLElement).getByRole("radio", {
        name: /publicerat/i,
      }),
    );
    await session.type(screen.getByLabelText(/^Pärm/), "Protokoll");

    // The guardrail: choosing the minutes binder moves the audience back to
    // the members, and the sentence explains that publishing is a deliberate
    // second answer rather than the default it just overrode.
    const audience = within(audienceField() as HTMLElement).getByRole("radio", {
      name: /medlemmar/i,
    });
    expect((audience as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByText(
        /Protokoll stannar hos medlemmarna tills styrelsen publicerar dem medvetet/,
      ),
    ).toBeTruthy();
  });

  it("still lets the board publish a set of minutes deliberately", async () => {
    const session = userEvent.setup();
    renderScreen(["documents:manage"]);

    await screen.findByRole("heading", { name: "Stadgar" });

    await session.type(screen.getByLabelText(/^Titel/), "Protokoll 2026");
    await session.type(screen.getByLabelText(/^Pärm/), "Protokoll");
    // Chosen after the binder, which is what makes it the deliberate answer
    // the guardrail asks for.
    await session.click(
      within(audienceField() as HTMLElement).getByRole("radio", {
        name: /publicerat/i,
      }),
    );
    await session.upload(
      screen.getByLabelText("Fil"),
      new File(["%PDF-1.7"], "protokoll.pdf", { type: "application/pdf" }),
    );
    await session.click(
      screen.getByRole("button", { name: "Lägg in dokumentet" }),
    );

    await waitFor(() => {
      expect(fileDocument).toHaveBeenCalledTimes(1);
    });
    expect(fileDocument.mock.calls[0]?.[0]).toMatchObject({
      audience: "PUBLIC",
    });
  });

  it("filters the shelf it was sent by audience", async () => {
    const session = userEvent.setup();
    renderScreen(["documents:manage"]);

    await screen.findByRole("heading", { name: "Stadgar" });
    await session.click(
      within(audienceFilter()).getByRole("radio", { name: /^medlemmar$/i }),
    );

    expect(screen.queryByRole("heading", { name: "Stadgar" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Protokoll" })).toBeTruthy();
  });

  it("shows the audience beside every document it may change", async () => {
    renderScreen(["documents:manage"]);

    const heading = await screen.findByRole("heading", { name: "Protokoll" });
    const shelf = heading.parentElement;
    expect(shelf).not.toBeNull();
    expect(
      within(shelf as HTMLElement).getByRole("button", { name: "Ändra" }),
    ).toBeTruthy();
  });
});
