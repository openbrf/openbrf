import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module";
import { ContactService } from "../contact/contact.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { HONEYPOT_FIELD } from "../http/honeypot";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

/**
 * The website's two public forms, through the real routing, the real limiter
 * and a real database.
 *
 * These are the first writes anyone with no account can make on the site
 * origin, and everything asserted here is about what that must not become.
 *
 * The exchange is form-encoded HTML in and a 303 out. It does not go through
 * this client, this API's JSON, or any script - a browser with JavaScript
 * switched off has to be able to complete it, and the assertions below send
 * exactly what such a browser sends.
 *
 * No response sets a cookie, ever. The submit path reads no session at all,
 * which is what makes that a property of the code rather than a habit.
 *
 * Nothing submitted comes back. The answer is a redirect to the page, and the
 * page renders a fixed translated sentence - so there is no path by which what
 * somebody typed reaches a browser.
 *
 * And a form that is not there is not there in both senses at once: with the
 * board's public-reporting switch off, the block renders as nothing AND the
 * endpoint answers byte for byte what a page that was never written answers.
 * A page carrying the block survives the switch being turned.
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let mail: MailService;
let contact: ContactService;

const suffix = process.hrtime.bigint().toString(36);

const publicSlug = `forms-public-${suffix}`;
const memberSlug = `forms-member-${suffix}`;
const plainSlug = `forms-plain-${suffix}`;

const boardMember = {
  personId: `forms-board-${suffix}`,
  email: `forms-board-${suffix}@exempel.se`,
};

const NON_MEMBER_TYPE = `Trasig port ${suffix}`;
const MEMBER_TYPE = `Vattenlacka ${suffix}`;
let nonMemberTypeId = "";
let memberTypeId = "";

/**
 * A distinct forwarded address per request, inside this suite's own block.
 *
 * The limiter buckets by forwarded address, so a repeat would make one suite's
 * requests count against another's budget - and this suite spends a 20-a-minute
 * budget deliberately, in the test that proves the limiter refuses. 10.16.0.0/16
 * is this suite's; the other integration suites each hold their own second
 * octet, and menu.int-spec.ts holds 10.15.
 */
let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return `10.16.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: string | object;
  headers?: Record<string, string>;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        // Fixed, so two responses compared for equality were rendered in the
        // same language and differ only where the test says they do.
        "accept-language": "sv-SE,sv;q=0.9",
        ...options.headers,
      },
    });
}

/**
 * Sends a form exactly as a browser with no JavaScript sends one.
 *
 * URL-encoded, with the content type a `<form method="post">` sets on its own.
 * That the API parses this at all is part of what is under test: nothing in
 * this application registers a body parser for it, because the Fastify adapter
 * already installs one, and a change that turned that off would break every
 * public form on the website.
 */
function submit(
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return inject({
    method: "POST",
    url,
    payload: new URLSearchParams(fields).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
  });
}

const CONTACT_AND_REPORT = {
  version: 1,
  blocks: [
    { type: "paragraph", runs: [{ text: "Så når du föreningen." }] },
    { type: "contactForm", intro: [{ text: "Styrelsen läser detta." }] },
    { type: "issueReportForm" },
  ],
};

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
  encryption = app.get(FieldEncryptionService);
  mail = app.get(MailService);
  contact = app.get(ContactService);

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      setupCompletedAt: new Date(),
      issueReportingPublic: true,
    },
    update: { setupCompletedAt: new Date(), issueReportingPublic: true },
  });

  const nonMember = await prisma.issueType.create({
    data: { name: NON_MEMBER_TYPE, audience: "NON_MEMBER", sortOrder: 900 },
    select: { id: true },
  });
  nonMemberTypeId = nonMember.id;
  const member = await prisma.issueType.create({
    data: { name: MEMBER_TYPE, audience: "MEMBER", sortOrder: 901 },
    select: { id: true },
  });
  memberTypeId = member.id;

  const email = await encryption.encrypt("person.email", boardMember.email);
  await prisma.person.create({
    data: {
      id: boardMember.personId,
      firstName: "Bea",
      lastName: "Ordforande",
      emailCipher: email.cipher,
      emailIndex: email.index,
      preferredLocale: "sv",
    },
  });
  await prisma.boardPosition.create({
    data: {
      personId: boardMember.personId,
      position: "CHAIR",
      electedOn: new Date("2025-05-15T00:00:00.000Z"),
    },
  });

  await prisma.page.createMany({
    data: [
      {
        slug: publicSlug,
        title: "Kontakta oss",
        content: CONTACT_AND_REPORT,
        visibility: "PUBLIC",
        published: true,
        publishedAt: new Date(),
        sortOrder: 800,
      },
      {
        // The same blocks behind a session. A form here would be a form whose
        // submission the endpoint refuses, so neither the form nor the endpoint
        // may exist for anybody.
        slug: memberSlug,
        title: "Endast medlemmar",
        content: CONTACT_AND_REPORT,
        visibility: "MEMBER",
        published: true,
        publishedAt: new Date(),
        sortOrder: 801,
      },
      {
        slug: plainSlug,
        title: "Om föreningen",
        content: {
          version: 1,
          blocks: [{ type: "paragraph", runs: [{ text: "Bildad 1948." }] }],
        },
        visibility: "PUBLIC",
        published: true,
        publishedAt: new Date(),
        sortOrder: 802,
      },
    ],
  });
}, 180_000);

afterAll(async () => {
  await prisma?.contactSubmission.deleteMany({
    where: { message: { contains: suffix } },
  });
  await prisma?.issue.deleteMany({
    where: { typeId: { in: [nonMemberTypeId, memberTypeId] } },
  });
  await prisma?.issueType.deleteMany({
    where: { id: { in: [nonMemberTypeId, memberTypeId] } },
  });
  await prisma?.page.deleteMany({
    where: { slug: { in: [publicSlug, memberSlug, plainSlug] } },
  });
  await prisma?.boardPosition.deleteMany({
    where: { personId: boardMember.personId },
  });
  await prisma?.person.deleteMany({ where: { id: boardMember.personId } });
  await app?.close();
});

describe("the forms on a public page", () => {
  it("are rendered with no script and with the board's own sentence", async () => {
    const response = await inject({ method: "GET", url: `/${publicSlug}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      `<form action="/${publicSlug}/kontakt" method="post">`,
    );
    expect(response.body).toContain(
      `<form action="/${publicSlug}/felanmalan" method="post">`,
    );
    expect(response.body).toContain("Styrelsen läser detta.");
    expect(response.body).toContain(NON_MEMBER_TYPE);
    // The board's internal and member-facing categories are never offered on
    // the public form. The filter is the server's, not the page's.
    expect(response.body.includes(MEMBER_TYPE)).toBe(false);
    expect(response.body.includes("<script")).toBe(false);
    expect(/\son[a-z]+=/i.test(response.body)).toBe(false);
  });

  it("are served under a policy that lets a form reach this instance only", async () => {
    const response = await inject({ method: "GET", url: `/${publicSlug}` });

    // form-action narrows the policy rather than widening it: default-src
    // 'none' says nothing about where a form submits to, so without this entry
    // a stored page could post somewhere else entirely.
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; " +
        "font-src 'self'; form-action 'self'",
    );
  });
});

describe("sending the contact form", () => {
  it("stores the message and sends the visitor back to the page", async () => {
    const message = `Porten går inte att stänga, ${suffix}.`;
    const response = await submit(`/${publicSlug}/kontakt`, {
      name: "Bo Ek",
      email: "bo@exempel.se",
      message,
    });

    // 303 rather than 302, so the browser follows it with a GET: the visitor
    // lands on an address they can reload and go back to without being offered
    // the form again.
    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe(`/${publicSlug}?skickat=kontakt`);
    expect(response.headers["set-cookie"]).toBeUndefined();

    const stored = await prisma.contactSubmission.findFirst({
      where: { message },
    });
    expect(stored?.name).toBe("Bo Ek");
    expect(stored?.handled).toBe(false);
    // The address is encrypted at rest, exactly as a sign-up request's is.
    expect(stored?.emailCipher).not.toContain("bo@exempel.se");
    expect(
      await encryption.decrypt(
        "contactSubmission.email",
        stored?.emailCipher ?? "",
      ),
    ).toBe("bo@exempel.se");
  });

  it("renders the confirmation on the page it went back to", async () => {
    const response = await inject({
      method: "GET",
      url: `/${publicSlug}?skickat=kontakt`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Meddelandet har nått styrelsen");
    // The form is gone, so a reload cannot send it twice - and the
    // confirmation repeats nothing that was written.
    expect(response.body.includes(`action="/${publicSlug}/kontakt"`)).toBe(
      false,
    );
    // The other form on the same page is untouched by it.
    expect(response.body).toContain(`action="/${publicSlug}/felanmalan"`);
  });

  it("drops a submission that filled the decoy, and says nothing about it", async () => {
    const message = `Bot-meddelande ${suffix}-honeypot.`;
    const honest = await submit(`/${publicSlug}/kontakt`, {
      name: "Bo Ek",
      email: "bo@exempel.se",
      message: `Ärligt meddelande ${suffix}-honest.`,
    });
    const trapped = await submit(`/${publicSlug}/kontakt`, {
      name: "Skript",
      email: "skript@exempel.invalid",
      message,
      [HONEYPOT_FIELD]: "https://spam.invalid",
    });

    // Answered exactly as a stored message is, down to the address it is sent
    // to: a script learns nothing about which field gave it away.
    expect(trapped.statusCode).toBe(honest.statusCode);
    expect(trapped.headers["location"]).toBe(honest.headers["location"]);
    expect(await prisma.contactSubmission.count({ where: { message } })).toBe(
      0,
    );
  });

  it("says it could not read a submission rather than storing half of it", async () => {
    const response = await submit(`/${publicSlug}/kontakt`, {
      email: "inte-en-adress",
      message: "   ",
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe(`/${publicSlug}?fel=kontakt`);

    const page = await inject({
      method: "GET",
      url: `/${publicSlug}?fel=kontakt`,
    });
    expect(page.body).toContain("Meddelandet kunde inte läsas.");
    // And the form is still there to try again with.
    expect(page.body).toContain(`action="/${publicSlug}/kontakt"`);
    // Nothing the visitor typed is echoed back onto the page.
    expect(page.body.includes("inte-en-adress")).toBe(false);
  });

  it("is refused past the budget for one client address", async () => {
    const address = "10.16.200.7";
    const fields = {
      email: "bo@exempel.se",
      message: `Upprepat ${suffix}.`,
    };

    let refused: Awaited<ReturnType<typeof submit>> | null = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await submit(`/${publicSlug}/kontakt`, fields, {
        "x-forwarded-for": address,
      });
      if (response.statusCode === 429) {
        refused = response;
        break;
      }
    }

    expect(refused?.statusCode).toBe(429);
    expect(refused?.json()).toMatchObject({ reason: "too-many-requests" });

    // The budget is per address: another visitor is not turned away by it.
    const neighbour = await submit(`/${publicSlug}/kontakt`, fields, {
      "x-forwarded-for": "10.16.201.7",
    });
    expect(neighbour.statusCode).toBe(303);
  });
});

describe("sending the issue report form", () => {
  it("files a report under a type the public was offered", async () => {
    const description = `Porten står på glänt, ${suffix}.`;
    const response = await submit(`/${publicSlug}/felanmalan`, {
      type: nonMemberTypeId,
      location: "Porten mot gatan",
      description,
      name: "Nina Granne",
      email: "nina@exempel.se",
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe(
      `/${publicSlug}?skickat=felanmalan`,
    );
    expect(response.headers["set-cookie"]).toBeUndefined();

    const issue = await prisma.issue.findFirst({ where: { description } });
    expect(issue?.typeId).toBe(nonMemberTypeId);
    expect(issue?.status).toBe("NEW");
    // No account behind it, and the contact details encrypted at rest.
    expect(issue?.reporterPersonId).toBeNull();
    expect(issue?.location).toBe("Porten mot gatan");
    expect(
      await encryption.decrypt(
        "issue.reporterEmail",
        issue?.reporterEmailCipher ?? "",
      ),
    ).toBe("nina@exempel.se");
    expect(
      await encryption.decrypt(
        "issue.reporterName",
        issue?.reporterNameCipher ?? "",
      ),
    ).toBe("Nina Granne");
  });

  it("refuses a type the form never offered, and files nothing", async () => {
    const description = `Internt ärende ${suffix}.`;
    const response = await submit(`/${publicSlug}/felanmalan`, {
      // A member-audience type, posted by an anonymous caller who was shown
      // only the non-member ones.
      type: memberTypeId,
      description,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe(`/${publicSlug}?fel=felanmalan`);
    expect(await prisma.issue.count({ where: { description } })).toBe(0);
  });

  it("takes a report from somebody who left no name or address", async () => {
    const description = `Anonym anmälan ${suffix}.`;
    const response = await submit(`/${publicSlug}/felanmalan`, {
      type: nonMemberTypeId,
      description,
    });

    expect(response.statusCode).toBe(303);
    const issue = await prisma.issue.findFirst({ where: { description } });
    expect(issue?.reporterNameCipher).toBeNull();
    expect(issue?.reporterEmailCipher).toBeNull();
  });
});

describe("what a form that is not there looks like", () => {
  /** The website's own not-found document, as everything else must match it. */
  async function missingPage(): Promise<string> {
    const response = await inject({
      method: "GET",
      url: "/en-sida-som-aldrig-skrivits",
    });
    return response.body;
  }

  it("is the not-found page for a page that carries no such form", async () => {
    const response = await submit(`/${plainSlug}/kontakt`, {
      email: "bo@exempel.se",
      message: `Fel sida ${suffix}.`,
    });

    expect(response.statusCode).toBe(404);
    // Byte for byte. The block on the page is the permission, and a submission
    // cannot be used to find out which of the association's pages have forms.
    expect(response.body).toBe(await missingPage());
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("is the not-found page for a page nobody may read", async () => {
    const response = await submit(`/${memberSlug}/kontakt`, {
      email: "bo@exempel.se",
      message: `Medlemssida ${suffix}.`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(await missingPage());
  });

  it("leaves the API's own paths to the API", async () => {
    /*
     * Two static segments outrank a parameter and a static one, so a real API
     * route always wins - but "/api/kontakt" names none, and without a guard it
     * would reach the page parameter here and be answered with the website's
     * HTML. It belongs to the API's JSON 404, exactly as "/api" does on the page
     * route beside this one.
     */
    const response = await submit("/api/kontakt", {
      email: "bo@exempel.se",
      message: `Fel namnrymd ${suffix}.`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ reason: "not-found" });
  });

  it("is the not-found page for an address that names no page at all", async () => {
    const response = await submit("/en-sida-som-aldrig-skrivits/kontakt", {
      email: "bo@exempel.se",
      message: `Ingen sida ${suffix}.`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(await missingPage());
  });
});

describe("the board's switch for public reports", () => {
  /*
   * Restored in a finally, always. Other suites depend on the association's
   * flags standing where they found them, and a switch left off here would take
   * the public form away from every test that ran afterwards.
   */
  async function withPublicReporting<T>(
    enabled: boolean,
    use: () => Promise<T>,
  ): Promise<T> {
    await prisma.association.update({
      where: { id: 1 },
      data: { issueReportingPublic: enabled },
    });
    try {
      return await use();
    } finally {
      await prisma.association.update({
        where: { id: 1 },
        data: { issueReportingPublic: true },
      });
    }
  }

  it("takes the form off the page without taking the page away", async () => {
    await withPublicReporting(false, async () => {
      const response = await inject({ method: "GET", url: `/${publicSlug}` });

      expect(response.statusCode).toBe(200);
      // The page is still there, and so is everything else on it. Only the
      // form is gone, so a board can close it without editing the page.
      expect(response.body).toContain("Så når du föreningen.");
      expect(response.body).toContain(`action="/${publicSlug}/kontakt"`);
      expect(response.body.includes(`action="/${publicSlug}/felanmalan"`)).toBe(
        false,
      );
      expect(response.body.includes(NON_MEMBER_TYPE)).toBe(false);
    });
  });

  it("answers the endpoint exactly as it answers a page that was never written", async () => {
    await withPublicReporting(false, async () => {
      const missing = await inject({
        method: "GET",
        url: "/en-sida-som-aldrig-skrivits",
      });
      const description = `Stängd anmälan ${suffix}.`;
      const response = await submit(`/${publicSlug}/felanmalan`, {
        type: nonMemberTypeId,
        description,
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(missing.body);
      expect(await prisma.issue.count({ where: { description } })).toBe(0);

      // The contact form on the same page is untouched: the switch is about
      // issue reports and nothing else.
      const contactResponse = await submit(`/${publicSlug}/kontakt`, {
        email: "bo@exempel.se",
        message: `Fortfarande öppet ${suffix}.`,
      });
      expect(contactResponse.statusCode).toBe(303);
    });
  });

  it("tells a script that fell for the decoy nothing about the switch", async () => {
    await withPublicReporting(false, async () => {
      const description = `Bot-anmälan ${suffix}.`;
      const response = await submit(`/${publicSlug}/felanmalan`, {
        type: nonMemberTypeId,
        description,
        [HONEYPOT_FIELD]: "https://spam.invalid",
      });

      // The decoy is read before the association's own settings are, so the
      // answer is the ordinary confirmation and reveals nothing.
      expect(response.statusCode).toBe(303);
      expect(response.headers["location"]).toBe(
        `/${publicSlug}?skickat=felanmalan`,
      );
      expect(await prisma.issue.count({ where: { description } })).toBe(0);
    });
  });
});

describe("telling the board", () => {
  it("sends each board member exactly one message, from its own job", async () => {
    const send = vi.spyOn(mail, "send").mockResolvedValue(undefined);
    try {
      const message = `Fanout ${suffix}.`;
      await submit(`/${publicSlug}/kontakt`, {
        name: "Bo Ek",
        email: "bo@exempel.se",
        message,
      });
      const stored = await prisma.contactSubmission.findFirst({
        where: { message },
        select: { id: true },
      });

      /*
       * The two halves driven explicitly, because that is what the queue does:
       * the first job reads who the board is, the second sends one message. A
       * retry of the second therefore cannot send anybody a second copy.
       *
       * At least one rather than exactly one: this suite adds a chair to a
       * database other suites have also elected people into, and how many that
       * is is not this test's subject.
       */
      expect(
        await contact.fanOutToBoard(stored?.id ?? ""),
      ).toBeGreaterThanOrEqual(1);
      expect(
        await contact.notifyBoardMember(stored?.id ?? "", boardMember.personId),
      ).toBe(true);

      expect(send).toHaveBeenCalledTimes(1);
      const sent = send.mock.calls[0]?.[0];
      expect(sent?.to).toBe(boardMember.email);
      expect(sent?.template.id).toBe("contact-submission");
    } finally {
      send.mockRestore();
    }
  });

  it("keeps the message when this instance cannot send mail at all", async () => {
    const send = vi
      .spyOn(mail, "send")
      .mockRejectedValue(new MailNotConfiguredError());
    try {
      const message = `Utan e-postserver ${suffix}.`;
      await submit(`/${publicSlug}/kontakt`, {
        email: "bo@exempel.se",
        message,
      });
      const stored = await prisma.contactSubmission.findFirst({
        where: { message },
        select: { id: true },
      });

      // Not a failure to retry, and above all not a message lost: the row is
      // written before anything is enqueued, and the board's inbox is the
      // record.
      await expect(
        contact.notifyBoardMember(stored?.id ?? "", boardMember.personId),
      ).resolves.toBe(false);
      expect(await prisma.contactSubmission.count({ where: { message } })).toBe(
        1,
      );
    } finally {
      send.mockRestore();
    }
  });
});

describe("the board's inbox", () => {
  it("is closed to a visitor with no session", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/contact-submissions",
    });

    expect(response.statusCode).toBe(401);
  });

  it("hands the board what was written, with the address decrypted", async () => {
    const message = `Inkorgen ${suffix}.`;
    await submit(`/${publicSlug}/kontakt`, {
      name: "Bo Ek",
      email: "bo@exempel.se",
      message,
    });

    const inbox = await contact.list();
    const entry = inbox.find((row) => row.message === message);
    expect(entry?.email).toBe("bo@exempel.se");
    expect(entry?.handled).toBe(false);

    const handled = await contact.setHandled({
      id: entry?.id ?? "",
      handled: true,
      byPersonId: boardMember.personId,
    });
    expect(handled.handled).toBe(true);
    expect(handled.handledAt).not.toBeNull();
  });

  it("refuses a message that is gone rather than failing on the database", async () => {
    // Reachable without anybody doing anything wrong: the list in front of the
    // board was read a moment ago, and these rows are removable. The board is
    // told, rather than shown the database's own failure as a server error.
    await expect(
      contact.setHandled({
        id: "contact-submission-that-is-not-there",
        handled: true,
        byPersonId: boardMember.personId,
      }),
    ).rejects.toMatchObject({ reason: "not-found", status: 404 });
  });

  it("lets the board remove a message for good", async () => {
    const message = `Att radera ${suffix}.`;
    await submit(`/${publicSlug}/kontakt`, {
      email: "bo@exempel.se",
      message,
    });
    const stored = await prisma.contactSubmission.findFirst({
      where: { message },
      select: { id: true },
    });

    await contact.remove(stored?.id ?? "");

    // The only bounded retention these rows have: most senders are nobody the
    // association holds a record of, so the person-keyed purge cannot reach
    // them and there is no move-out date to count a period from.
    expect(await prisma.contactSubmission.count({ where: { message } })).toBe(
      0,
    );
    await expect(contact.remove(stored?.id ?? "")).rejects.toMatchObject({
      reason: "not-found",
    });
  });
});
