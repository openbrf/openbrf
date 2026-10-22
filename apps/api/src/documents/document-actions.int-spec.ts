import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  type ActionCaller,
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import { LiveResponse } from "../actions/testing/live-response";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { textPdfBytes } from "../media/testing/document-fixtures";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { DocumentsService } from "./documents.service";

/**
 * The document reads against a real instance (ADR 0041).
 *
 * Four documents on the three shelves, filed through the archive's own upload
 * path so their files are stored encrypted as every file is, and four people:
 * a board member who lives elsewhere, a member, a resident who is not a member,
 * and a property manager. What is asserted is the shelf boundary as each of
 * them meets it through a connected app - the board's shelf reached by nobody,
 * the members' by a member and the board, the public one by all - and that the
 * text comes out of the stored PDF, with a scan answered as having none.
 */

loadEnvForIntegrationTests();

let moduleRef: TestingModule;
let prisma: PrismaService;
let registry: ActionRegistryService;
let callers: ActionCallerFactory;

const suffix = runSuffix();

const board = { personId: `document-action-board-${suffix}` };
const member = { personId: `document-action-member-${suffix}` };
const resident = { personId: `document-action-resident-${suffix}` };
const manager = { personId: `document-action-manager-${suffix}` };
const personIds = [
  board.personId,
  member.personId,
  resident.personId,
  manager.personId,
];

const addressId = `document-action-address-${suffix}`;
const apartmentId = `document-action-apartment-${suffix}`;

/** The titles carry the suffix, so a search finds this run's and no other's. */
const titles = {
  board: `Styrelsens anteckningar ${suffix}`,
  minutes: `Protokoll stämma ${suffix}`,
  bylaws: `Stadgar ${suffix}`,
  scan: `Inskannad kallelse ${suffix}`,
};

const ids: Record<keyof typeof titles, string> = {
  board: "",
  minutes: "",
  bylaws: "",
  scan: "",
};

/** A connected app acting as the given person, built where the guard stands. */
function connectedApp(personId: string): ActionCaller {
  const token = {
    tokenRowId: `token-${suffix}`,
    clientId: `client-${suffix}`,
    clientHost: "app.example",
    scopes: ["mcp:read"],
  };
  const request = {
    id: `request-${suffix}`,
    principal: { personId, capabilities: new Set<string>() },
    token,
  } as unknown as RequestWithToken;
  markAuthenticated(request, new LiveResponse(), {
    personId,
    token,
    requestId: request.id,
  });
  return callers.forRequest(request);
}

interface Listed {
  documents: { id: string; title: string; audience: string }[];
  more: boolean;
}

async function listed(personId: string): Promise<string[]> {
  const page = (await registry.invoke(connectedApp(personId), "document_list", {
    search: suffix,
    limit: 50,
  })) as Listed;
  return page.documents.map((document) => document.title).sort();
}

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  await moduleRef.init();

  prisma = moduleRef.get(PrismaService);
  registry = moduleRef.get(ActionRegistryService);
  callers = moduleRef.get(ActionCallerFactory);

  await prisma.person.createMany({
    data: [
      { id: board.personId, firstName: "Bo", lastName: `Arkiv${suffix}` },
      { id: member.personId, firstName: "Maj", lastName: `Arkiv${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Arkiv${suffix}` },
      { id: manager.personId, firstName: "Per", lastName: `Arkiv${suffix}` },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });
  await prisma.address.create({
    data: {
      id: addressId,
      street: `Arkivgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: member.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: new Date("2020-01-01"),
      },
      {
        personId: resident.personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: new Date("2020-01-01"),
      },
    ],
  });

  const documents = moduleRef.get(DocumentsService);
  const file = async (
    key: keyof typeof titles,
    category: string,
    audience: "BOARD" | "MEMBER" | "PUBLIC",
    pages: (string | null)[],
  ): Promise<void> => {
    const added = await documents.add({
      title: titles[key],
      category,
      audience,
      bytes: textPdfBytes(pages),
      fileName: `${key}.pdf`,
      actorPersonId: board.personId,
    });
    ids[key] = added.id;
  };
  await file("board", "Styrelsen", "BOARD", ["Styrelsens egna anteckningar"]);
  await file("minutes", "Protokoll", "MEMBER", [
    "Protokoll fört vid ordinarie föreningsstämma",
    "§ 7 Stämman beslutade att bygga laddplatser",
  ]);
  await file("bylaws", "Stadgar", "PUBLIC", ["Föreningens stadgar"]);
  await file("scan", "Kallelser", "PUBLIC", [null]);
});

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      // The document rows go with their files, by the cascade on the
      // reference.
      await prisma.mediaFile.deleteMany({
        where: { uploadedByPersonId: { in: personIds } },
      });
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.apartment.deleteMany({ where: { id: apartmentId } });
      await prisma.address.deleteMany({ where: { id: addressId } });
      await prisma.systemRole.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    }
  } finally {
    await moduleRef?.close();
  }
});

describe("which shelves each person reaches through an app", () => {
  it("lists the members' and the public shelf to a member", async () => {
    expect(await listed(member.personId)).toEqual(
      [titles.scan, titles.minutes, titles.bylaws].sort(),
    );
  });

  it("lists the public shelf only to a resident who is not a member", async () => {
    expect(await listed(resident.personId)).toEqual(
      [titles.scan, titles.bylaws].sort(),
    );
  });

  it("lists the public shelf only to the property manager", async () => {
    expect(await listed(manager.personId)).toEqual(
      [titles.scan, titles.bylaws].sort(),
    );
  });

  it("lists the members' and the public shelf to the board, and not its own", async () => {
    expect(await listed(board.personId)).toEqual(
      [titles.scan, titles.minutes, titles.bylaws].sort(),
    );
  });

  it.each([
    ["the board", board],
    ["a member", member],
    ["a resident", resident],
  ])("refuses a board document to %s as not found", async (_name, person) => {
    await expect(
      registry.invoke(connectedApp(person.personId), "document_get", {
        id: ids.board,
      }),
    ).rejects.toMatchObject({ reason: "not-found" });
  });

  it("refuses the members' shelf to a resident who is not a member", async () => {
    await expect(
      registry.invoke(connectedApp(resident.personId), "document_get", {
        id: ids.minutes,
      }),
    ).rejects.toMatchObject({ reason: "not-found" });
  });

  it("serves no board file, so the log records no board file opened", async () => {
    const opened = await prisma.auditLogEntry.count({
      where: { action: "MEDIA_ACCESSED", actorPersonId: { in: personIds } },
    });
    expect(opened).toBe(0);
  });
});

describe("what document_get reads out of the stored file", () => {
  it("reads the pages of the minutes, decrypted and parsed in the call", async () => {
    const answer = (await registry.invoke(
      connectedApp(member.personId),
      "document_get",
      { id: ids.minutes, fromPage: 2 },
    )) as {
      title: string;
      pageCount: number;
      pages: { number: number; text: string }[];
      textLayer: boolean;
    };

    expect(answer).toMatchObject({
      title: titles.minutes,
      pageCount: 2,
      pages: [
        { number: 2, text: "§ 7 Stämman beslutade att bygga laddplatser" },
      ],
      textLayer: true,
      truncated: false,
      next: null,
    });
  });

  it("says a scan has no text layer", async () => {
    const answer = (await registry.invoke(
      connectedApp(resident.personId),
      "document_get",
      { id: ids.scan },
    )) as { textLayer: boolean };

    expect(answer.textLayer).toBe(false);
  });

  it("searches the title and the binder, never the text", async () => {
    const page = (await registry.invoke(
      connectedApp(member.personId),
      "document_list",
      { search: "laddplatser", limit: 50 },
    )) as Listed;

    expect(
      page.documents.filter((document) => document.id === ids.minutes),
    ).toEqual([]);
  });
});
