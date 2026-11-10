import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { IssueFreeTextService } from "../issues/issue-free-text.service";
import { IssueRedactionService } from "../issues/issue-redaction.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import type { DataSubjectReport } from "./data-subject-report";
import { DataSubjectReportService } from "./data-subject-report.service";
import type { IssueAccessWeighingView } from "./issue-access-weighing.service";

/**
 * The board's art. 15(4) weighing of an issue's text for one person's access
 * report (ADR 0057), over HTTP and against a real database.
 *
 * What is under test is what reaches whose report. A reporter's report carries
 * the internal notes on their issue only as the board weighed each, and never
 * who wrote one. A person a handler recorded as concerned gets the case
 * somebody else reported: always its number, type, dates and where it stands,
 * its words only as weighed, and never its reporter. A text given in part is
 * given as the board's copy with words left out, and the text itself stays as
 * written. The weighing is the board's, under the report's own gate, and the
 * log names the person and never the issue.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let reports: DataSubjectReportService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

function person(key: string, firstName: string) {
  return {
    personId: `aw-${key}-${suffix}`,
    email: `aw-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `Vagning${suffix}`,
  };
}

const board = person("board", "Bea");
const manager = person("manager", "Frida");
const reporter = person("reporter", "Rut");
const neighbour = person("neighbour", "Nils");
/** Somebody neither reporter nor concerned, whose report holds no case. */
const stranger = person("stranger", "Sten");
const accounts = [board, manager];
const people = [board, manager, reporter, neighbour, stranger];
const personIds = people.map((entry) => entry.personId);

const typeId = `aw-type-${suffix}`;
let type: IssueTypeFixture;

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT";
  url: string;
  payload?: object;
  cookie?: string;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        // 10.86.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.86.${String(subnet)}.${String(host + 1)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
    });
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

const cookies: Record<string, string> = {};

function weighingUrl(personId: string, issueId: string): string {
  return `/api/data-subject-reports/persons/${personId}/issues/${issueId}/weighing`;
}

async function readWeighing(
  personId: string,
  issueId: string,
): Promise<IssueAccessWeighingView> {
  const response = await inject({
    method: "GET",
    url: weighingUrl(personId, issueId),
    cookie: cookies[board.personId],
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  return response.json() as IssueAccessWeighingView;
}

function weigh(
  personId: string,
  issueId: string,
  decisions: readonly object[],
  who: { personId: string } = board,
) {
  return inject({
    method: "PUT",
    url: weighingUrl(personId, issueId),
    payload: { decisions },
    cookie: cookies[who.personId],
  });
}

function reportOf(personId: string): Promise<DataSubjectReport> {
  return reports.generate({ personId, actorPersonId: board.personId });
}

/** An issue of this run's type, open unless a meaning is given. */
async function filed(input: {
  reporterPersonId: string | null;
  description: string;
  location?: string;
  meaning?: "NEW" | "DONE";
}): Promise<{ id: string; number: number }> {
  const meaning = input.meaning ?? "NEW";
  return prisma.issue.create({
    data: {
      typeId,
      statusId: type.statusIds[meaning],
      reporterPersonId: input.reporterPersonId,
      description: input.description,
      location: input.location ?? null,
      ...(meaning === "DONE"
        ? { outcome: "FIXED", closedAt: new Date("2026-10-01T10:00:00Z") }
        : {}),
    },
    select: { id: true, number: true },
  });
}

function note(issueId: string, body: string) {
  return prisma.issueNote.create({
    data: { issueId, authorPersonId: board.personId, body },
    select: { id: true },
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  reports = app.get(DataSubjectReportService);

  await prisma.person.createMany({
    data: people.map((entry) => ({
      id: entry.personId,
      firstName: entry.firstName,
      lastName: entry.lastName,
    })),
  });
  // The board member holds `protectedData:reveal` through the seat, which the
  // report and its weighing ask; the property manager does not.
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
  const auth = app.get(AuthService);
  for (const entry of accounts) {
    await auth.createAccountForPerson({
      personId: entry.personId,
      email: entry.email,
      name: "Test Person",
      password: PASSWORD,
    });
    cookies[entry.personId] = await signIn(entry.email);
  }

  type = await createIssueTypeFixture(prisma, {
    id: typeId,
    name: `Störningar ${suffix}`,
    reporters: ["RESIDENTS"],
  });
}, 120_000);

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      // The issues take their notes, messages, records and weighings with them.
      await prisma.issue.deleteMany({ where: { typeId } });
      await prisma.issueType.deleteMany({ where: { id: typeId } });
      await prisma.session.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.account.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.user.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.systemRole.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    }
  } finally {
    await app?.close();
  }
});

describe("the reporter's internal notes", () => {
  it("gives a note only as the board weighed it, and never who wrote it", async () => {
    const issue = await filed({
      reporterPersonId: reporter.personId,
      description: `Läcka i taket ${suffix}`,
    });
    const about = await note(issue.id, `Rut ringde igen ${suffix}`);
    const other = await note(issue.id, `Grannen i 1202 har klagat ${suffix}`);

    // Before anybody weighed them: there, by date, with none of their words.
    const unweighed = await reportOf(reporter.personId);
    const before = unweighed.issues.find((entry) => entry.issueId === issue.id);
    expect(before?.notes).toEqual([
      expect.objectContaining({
        noteId: about.id,
        content: { state: "unweighed" },
      }),
      expect.objectContaining({
        noteId: other.id,
        content: { state: "unweighed" },
      }),
    ]);
    expect(JSON.stringify(unweighed)).not.toContain(`Rut ringde igen`);

    // The board reads the notes to weigh, and only the notes.
    const view = await readWeighing(reporter.personId, issue.id);
    expect(view.report).toBe("reporter");
    expect(
      view.texts.map((text) => [text.part, text.id, text.decision]),
    ).toEqual([
      ["NOTE", about.id, null],
      ["NOTE", other.id, null],
    ]);

    const saved = await weigh(reporter.personId, issue.id, [
      { part: "NOTE", id: about.id, withheldBecause: null },
      { part: "NOTE", id: other.id, withheldBecause: "ABOUT_ANOTHER_PERSON" },
    ]);
    expect(saved.statusCode).toBe(200);
    expect(
      (saved.json() as IssueAccessWeighingView).texts.map(
        (text) => text.decision,
      ),
    ).toEqual(["given", "ABOUT_ANOTHER_PERSON"]);

    // A note written after the weighing has not been weighed.
    const later = await note(issue.id, `Ny anteckning ${suffix}`);

    const report = await reportOf(reporter.personId);
    const entry = report.issues.find((item) => item.issueId === issue.id);
    expect(entry?.notes).toEqual([
      expect.objectContaining({
        noteId: about.id,
        content: { state: "given", text: `Rut ringde igen ${suffix}` },
      }),
      expect.objectContaining({
        noteId: other.id,
        content: { state: "withheld", because: "ABOUT_ANOTHER_PERSON" },
      }),
      expect.objectContaining({
        noteId: later.id,
        content: { state: "unweighed" },
      }),
    ]);
    const text = JSON.stringify(report);
    expect(text).not.toContain(`Grannen i 1202`);
    expect(text).not.toContain(`Ny anteckning ${suffix}`);
    // Never the handler who wrote it.
    expect(JSON.stringify(entry?.notes)).not.toContain(board.personId);
  });

  it("refuses to weigh the reporter's own words, or to leave a note out for naming them", async () => {
    const issue = await filed({
      reporterPersonId: reporter.personId,
      description: `Trasig dörr ${suffix}`,
    });
    const written = await note(issue.id, `Kollat dörren ${suffix}`);

    const description = await weigh(reporter.personId, issue.id, [
      { part: "DESCRIPTION", id: null, withheldBecause: null },
    ]);
    expect(description.statusCode).toBe(422);
    expect(description.json()).toMatchObject({ reason: "text-not-weighable" });

    const naming = await weigh(reporter.personId, issue.id, [
      { part: "NOTE", id: written.id, withheldBecause: "IDENTIFIES_REPORTER" },
    ]);
    expect(naming.statusCode).toBe(422);
    expect(naming.json()).toMatchObject({ reason: "reason-not-allowed" });

    const twice = await weigh(reporter.personId, issue.id, [
      { part: "NOTE", id: written.id, withheldBecause: null },
      { part: "NOTE", id: written.id, withheldBecause: null },
    ]);
    expect(twice.statusCode).toBe(422);

    // Nothing was recorded by any of them.
    expect(
      await prisma.issueAccessWeighing.count({ where: { issueId: issue.id } }),
    ).toBe(0);
  });
});

describe("a case about a person who did not report it", () => {
  it("gives the case and its words as weighed, and never its reporter", async () => {
    const issue = await filed({
      reporterPersonId: reporter.personId,
      description: `Jag i 1102 hör musik från grannen varje natt ${suffix}`,
      location: `Trapphuset ${suffix}`,
      meaning: "DONE",
    });
    await prisma.issueConcernedPerson.create({
      data: { issueId: issue.id, personId: neighbour.personId },
    });
    const reply = await prisma.issueMessage.create({
      data: {
        issueId: issue.id,
        side: "HANDLER",
        signature: "BOARD",
        authorPersonId: board.personId,
        body: `Vi har pratat med grannen ${suffix}`,
      },
      select: { id: true },
    });
    const written = await note(
      issue.id,
      `Nils sa att det var en fest ${suffix}`,
    );

    const unweighed = await reportOf(neighbour.personId);
    const before = unweighed.issuesConcerning.find(
      (entry) => entry.issueId === issue.id,
    );
    // The case itself is never left out.
    expect(before).toMatchObject({
      number: issue.number,
      typeName: `Störningar ${suffix}`,
      meaning: "DONE",
      outcome: "FIXED",
      closedAt: "2026-10-01T10:00:00.000Z",
      description: { state: "unweighed" },
      location: { state: "unweighed" },
    });
    expect(before?.messages).toEqual([
      expect.objectContaining({
        messageId: reply.id,
        side: "HANDLER",
        signature: "BOARD",
        content: { state: "unweighed" },
      }),
    ]);
    // Not in the person's own `issues`, which are the ones they reported.
    expect(unweighed.issues.map((entry) => entry.issueId)).not.toContain(
      issue.id,
    );

    const view = await readWeighing(neighbour.personId, issue.id);
    expect(view.report).toBe("concerned");
    expect(view.texts.map((text) => text.part)).toEqual([
      "DESCRIPTION",
      "LOCATION",
      "MESSAGE",
      "NOTE",
    ]);

    const saved = await weigh(neighbour.personId, issue.id, [
      {
        part: "DESCRIPTION",
        id: null,
        withheldBecause: "IDENTIFIES_REPORTER",
      },
      { part: "LOCATION", id: null, withheldBecause: null },
      { part: "MESSAGE", id: reply.id, withheldBecause: null },
      { part: "NOTE", id: written.id, withheldBecause: null },
    ]);
    expect(saved.statusCode).toBe(200);

    const report = await reportOf(neighbour.personId);
    const entry = report.issuesConcerning.find(
      (item) => item.issueId === issue.id,
    );
    expect(entry).toMatchObject({
      description: { state: "withheld", because: "IDENTIFIES_REPORTER" },
      location: { state: "given", text: `Trapphuset ${suffix}` },
      messages: [
        expect.objectContaining({
          content: {
            state: "given",
            text: `Vi har pratat med grannen ${suffix}`,
          },
        }),
      ],
      notes: [
        expect.objectContaining({
          content: {
            state: "given",
            text: `Nils sa att det var en fest ${suffix}`,
          },
        }),
      ],
    });
    const text = JSON.stringify(report.issuesConcerning);
    // Never the reporter, nor the words the board left out.
    expect(text).not.toContain(reporter.personId);
    expect(text).not.toContain(reporter.lastName);
    expect(text).not.toContain("Jag i 1102");
    // And never who wrote a handler's message or a note.
    expect(text).not.toContain(board.personId);

    // The reporter's own weighing is apart from the neighbour's.
    const reporterView = await readWeighing(reporter.personId, issue.id);
    expect(reporterView.texts).toEqual([
      expect.objectContaining({ part: "NOTE", decision: null }),
    ]);
  });

  it("logs the weighing against the person, and never the issue or the text", async () => {
    const issue = await filed({
      reporterPersonId: null,
      description: `Rökning på balkongen ${suffix}`,
    });
    await prisma.issueConcernedPerson.create({
      data: { issueId: issue.id, personId: neighbour.personId },
    });
    const saved = await weigh(neighbour.personId, issue.id, [
      {
        part: "DESCRIPTION",
        id: null,
        withheldBecause: "ABOUT_ANOTHER_PERSON",
      },
    ]);
    expect(saved.statusCode).toBe(200);

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "ISSUE_ACCESS_WEIGHED",
        actorPersonId: board.personId,
        targetPersonId: neighbour.personId,
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      channel: "WEB",
      targetKind: null,
      targetId: null,
      context: { given: 0, givenInPart: 0, withheld: 1 },
    });
    expect(JSON.stringify(entries[0])).not.toContain(issue.id);
    expect(JSON.stringify(entries[0])).not.toContain("Rökning");
  });

  it("is the report's own gate, and refuses an issue the report does not carry", async () => {
    const issue = await filed({
      reporterPersonId: reporter.personId,
      description: `Hissen står still ${suffix}`,
    });

    const manager403 = await inject({
      method: "GET",
      url: weighingUrl(reporter.personId, issue.id),
      cookie: cookies[manager.personId],
    });
    expect(manager403.statusCode).toBe(403);
    const managerPut = await weigh(reporter.personId, issue.id, [], manager);
    expect(managerPut.statusCode).toBe(403);

    const notOnReport = await inject({
      method: "GET",
      url: weighingUrl(stranger.personId, issue.id),
      cookie: cookies[board.personId],
    });
    expect(notOnReport.statusCode).toBe(404);
    expect(notOnReport.json()).toMatchObject({ reason: "issue-not-in-report" });
    expect(
      (await reportOf(stranger.personId)).issuesConcerning.map(
        (entry) => entry.issueId,
      ),
    ).not.toContain(issue.id);
  });

  it("goes with the record whose report it is, and with the free-text layer", async () => {
    const recorded = await filed({
      reporterPersonId: reporter.personId,
      description: `Hund skäller ${suffix}`,
    });
    const record = await prisma.issueConcernedPerson.create({
      data: { issueId: recorded.id, personId: neighbour.personId },
      select: { id: true },
    });
    expect(
      (
        await weigh(neighbour.personId, recorded.id, [
          { part: "DESCRIPTION", id: null, withheldBecause: null },
        ])
      ).statusCode,
    ).toBe(200);
    // A handler takes the record off as a redaction, which deletes the row.
    await prisma.issueConcernedPerson.delete({ where: { id: record.id } });
    expect(
      await prisma.issueAccessWeighing.count({
        where: { issueId: recorded.id },
      }),
    ).toBe(0);

    const purged = await filed({
      reporterPersonId: reporter.personId,
      description: `Ventilationen brummar ${suffix}`,
      meaning: "DONE",
    });
    await prisma.issueConcernedPerson.create({
      data: { issueId: purged.id, personId: neighbour.personId },
    });
    // A work order's text stands on a clock of its own, so the record stays
    // as a bare selector when the layer goes: the weighing on it must go all
    // the same, with nothing left to weigh.
    await prisma.workOrder.create({
      data: {
        issueId: purged.id,
        recipientName: `Fläktfirman ${suffix}`,
        body: "Byt fläktmotorn.",
        deliveryStatus: "SENT",
      },
    });
    const written = await note(purged.id, `Kollat fläkten ${suffix}`);
    expect(
      (
        await weigh(neighbour.personId, purged.id, [
          { part: "DESCRIPTION", id: null, withheldBecause: null },
        ])
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await weigh(reporter.personId, purged.id, [
          { part: "NOTE", id: written.id, withheldBecause: null },
        ])
      ).statusCode,
    ).toBe(200);
    expect(
      await app.get(IssueFreeTextService).remove(purged.id, new Date(), {
        stillDue: () => Promise.resolve(true),
        targetPersonId: null,
        context: { ground: "test" },
      }),
    ).toBe("removed");
    expect(
      await prisma.issueConcernedPerson.count({
        where: { issueId: purged.id, recordRemovedAt: { not: null } },
      }),
    ).toBe(1);
    expect(
      await prisma.issueAccessWeighing.count({ where: { issueId: purged.id } }),
    ).toBe(0);
  });
});

describe("a text given in part", () => {
  it("gives the board's copy in its place, and leaves the text as written for everybody else", async () => {
    const description = `Jag i lägenhet 1102 hör grannen spela musik varje natt ${suffix}`;
    const copy = `Jag […] hör grannen spela musik varje natt ${suffix}`;
    const issue = await filed({
      reporterPersonId: reporter.personId,
      description,
    });
    await prisma.issueConcernedPerson.create({
      data: { issueId: issue.id, personId: neighbour.personId },
    });

    const saved = await weigh(neighbour.personId, issue.id, [
      {
        part: "DESCRIPTION",
        id: null,
        withheldBecause: "IDENTIFIES_REPORTER",
        givenText: copy,
      },
    ]);
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as IssueAccessWeighingView).texts).toEqual([
      expect.objectContaining({
        part: "DESCRIPTION",
        text: description,
        decision: "IDENTIFIES_REPORTER",
        givenText: copy,
      }),
    ]);

    const report = await reportOf(neighbour.personId);
    const entry = report.issuesConcerning.find(
      (item) => item.issueId === issue.id,
    );
    expect(entry?.description).toEqual({
      state: "givenInPart",
      text: copy,
      because: "IDENTIFIES_REPORTER",
    });
    // None of the words left out.
    expect(JSON.stringify(report.issuesConcerning)).not.toContain("1102");

    // The text itself is untouched: on the issue, and on the reporter's own
    // report, which gives them their own words whole.
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { description: true, descriptionRedactedAt: true },
      }),
    ).toEqual({ description, descriptionRedactedAt: null });
    expect(
      (await reportOf(reporter.personId)).issues.find(
        (item) => item.issueId === issue.id,
      )?.description,
    ).toBe(description);

    const [entryLogged] = await prisma.auditLogEntry.findMany({
      where: {
        action: "ISSUE_ACCESS_WEIGHED",
        actorPersonId: board.personId,
        targetPersonId: neighbour.personId,
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(entryLogged?.context).toEqual({
      given: 0,
      givenInPart: 1,
      withheld: 0,
    });
    // Never the copy either.
    expect(JSON.stringify(entryLogged)).not.toContain("grannen spela");
  });

  it("refuses a copy that is not the text with words left out, and keeps the weighing before it", async () => {
    const description = `Grannen i 1205 röker på balkongen ${suffix}`;
    const issue = await filed({
      reporterPersonId: reporter.personId,
      description,
    });
    await prisma.issueConcernedPerson.create({
      data: { issueId: issue.id, personId: neighbour.personId },
    });
    const standing = `Grannen […] röker på balkongen ${suffix}`;
    expect(
      (
        await weigh(neighbour.personId, issue.id, [
          {
            part: "DESCRIPTION",
            id: null,
            withheldBecause: "IDENTIFIES_REPORTER",
            givenText: standing,
          },
        ])
      ).statusCode,
    ).toBe(200);

    for (const refused of [
      // A word the text does not hold.
      {
        withheldBecause: "IDENTIFIES_REPORTER",
        givenText: `Grannen […] röker ofta på balkongen ${suffix}`,
      },
      // Words gone with no mark where they were.
      {
        withheldBecause: "IDENTIFIES_REPORTER",
        givenText: `Grannen röker på balkongen ${suffix}`,
      },
      // Words gone from the end, where the copy has no mark.
      {
        withheldBecause: "IDENTIFIES_REPORTER",
        givenText: "Grannen […] röker på balkongen",
      },
      // Nothing of it kept: that is leaving it out.
      { withheldBecause: "IDENTIFIES_REPORTER", givenText: "[…]" },
      // A copy with no reason for what it leaves out.
      { withheldBecause: null, givenText: standing },
    ]) {
      const response = await weigh(neighbour.personId, issue.id, [
        { part: "DESCRIPTION", id: null, ...refused },
      ]);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ reason: "copy-not-in-part" });
    }
    expect((await readWeighing(neighbour.personId, issue.id)).texts).toEqual([
      expect.objectContaining({
        decision: "IDENTIFIES_REPORTER",
        givenText: standing,
      }),
    ]);
  });

  it("goes with a handler's redaction of the text, the copy with it", async () => {
    const issue = await filed({
      reporterPersonId: reporter.personId,
      description: `Grannen i 1301 spelar trummor ${suffix}`,
    });
    await prisma.issueConcernedPerson.create({
      data: { issueId: issue.id, personId: neighbour.personId },
    });
    const written = await note(issue.id, `Ringt 1301 om trummorna ${suffix}`);
    expect(
      (
        await weigh(neighbour.personId, issue.id, [
          {
            part: "DESCRIPTION",
            id: null,
            withheldBecause: "IDENTIFIES_REPORTER",
            givenText: `Grannen […] spelar trummor ${suffix}`,
          },
          {
            part: "NOTE",
            id: written.id,
            withheldBecause: "ABOUT_ANOTHER_PERSON",
            givenText: `Ringt […] om trummorna ${suffix}`,
          },
        ])
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await weigh(reporter.personId, issue.id, [
          {
            part: "NOTE",
            id: written.id,
            withheldBecause: "ABOUT_ANOTHER_PERSON",
            givenText: `Ringt […] om trummorna ${suffix}`,
          },
        ])
      ).statusCode,
    ).toBe(200);

    const redaction = app.get(IssueRedactionService);
    await redaction.redact(board.personId, issue.id, {
      target: "description",
    });
    await redaction.redact(board.personId, issue.id, {
      target: "note",
      id: written.id,
    });

    // Nothing of either text is left in a weighing, for either report.
    expect(
      await prisma.issueAccessWeighing.count({ where: { issueId: issue.id } }),
    ).toBe(0);
    const entry = (await reportOf(neighbour.personId)).issuesConcerning.find(
      (item) => item.issueId === issue.id,
    );
    expect(entry?.description).toBeNull();
    expect(JSON.stringify(entry)).not.toContain("trummor");
  });
});
