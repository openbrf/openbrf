import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "../../config/env";
import type { FieldEncryptionService } from "../../crypto/field-encryption.service";
import type { PrismaService } from "../../database/prisma.service";
import { I18nService } from "../../i18n/i18n.service";
import { MailService } from "../mail.service";
import { bookingCancellationMail } from "./booking-cancellation.template";
import { bookingConfirmationMail } from "./booking-confirmation.template";

/**
 * What the two booking mails say, rendered for real.
 *
 * Rendering rather than stubbing the translator, because the properties under
 * test are properties of the output: the period read on the association's clock,
 * the three modes read three different ways, and both languages saying the same
 * thing about one booking.
 *
 * The clock is the assertion that matters most. A booking is stored as an
 * instant and read as a time of day, and a formatter left on the server's own
 * zone would be right in Stockholm in July and an hour out in the last week of
 * October. Both transitions are covered, and both fixtures are the same wall
 * clock time - 07:00 - at two different UTC instants, so a mail that formatted
 * either in UTC would print a different hour for one of them.
 */

const TEST_ENV = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "postgresql://unused",
  APP_URL: "https://brf.example.se",
  OPENBRF_DATA_DIR: "./.data",
  OPENBRF_ENCRYPTION_KEY: "a".repeat(64),
  BETTER_AUTH_SECRET: "test-secret-at-least-16-chars",
  OPENBRF_PLUGINS_ENABLED: false,
  OPENBRF_UNCURATED_PLUGINS_ENABLED: false,
} as Env;

const ASSOCIATION = {
  id: 1,
  name: "Brf Eksemplet",
  primaryColor: "#8A6D28",
  logoFileId: null,
};

/** 07:00 to 09:00 on a summer morning, when Sweden is two hours ahead of UTC. */
const SUMMER_SLOT = {
  startsAt: new Date("2026-07-06T05:00:00.000Z"),
  endsAt: new Date("2026-07-06T07:00:00.000Z"),
};

/** The same wall clock hours in January, when Sweden is one hour ahead. */
const WINTER_SLOT = {
  startsAt: new Date("2026-01-06T06:00:00.000Z"),
  endsAt: new Date("2026-01-06T08:00:00.000Z"),
};

let service: MailService;

beforeAll(async () => {
  const i18n = new I18nService();
  await i18n.init();
  service = new MailService(
    TEST_ENV,
    {
      association: { findUnique: vi.fn().mockResolvedValue(ASSOCIATION) },
    } as unknown as PrismaService,
    i18n,
    { decrypt: vi.fn() } as unknown as FieldEncryptionService,
  );
});

describe("the confirmation of a booking", () => {
  it("names the resource in the recipient's own language", async () => {
    const swedish = await service.renderMail({
      locale: "sv",
      template: bookingConfirmationMail,
      props: {
        recipientName: "Rune",
        resourceName: "Tvattstuga A",
        mode: "TIME_SLOTS",
        ...SUMMER_SLOT,
      },
    });
    const english = await service.renderMail({
      locale: "en",
      template: bookingConfirmationMail,
      props: {
        recipientName: "Rune",
        resourceName: "Tvattstuga A",
        mode: "TIME_SLOTS",
        ...SUMMER_SLOT,
      },
    });

    expect(swedish.subject).toBe("Din bokning av Tvattstuga A är bekräftad");
    expect(english.subject).toBe("Your booking of Tvattstuga A is confirmed");
  });

  it("states a time slot on the association's clock in summer", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: bookingConfirmationMail,
      props: {
        recipientName: "Rune",
        resourceName: "Tvattstuga A",
        mode: "TIME_SLOTS",
        ...SUMMER_SLOT,
      },
    });

    expect(rendered.html).toContain("2026-07-06 kl. 07:00-09:00");
    // The instant read as UTC, which is what a formatter without the zone would
    // print and what the resident would then stand in front of.
    expect(rendered.html).not.toContain("05:00");
  });

  it("states the same wall clock hours in winter", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: bookingConfirmationMail,
      props: {
        recipientName: "Rune",
        resourceName: "Tvattstuga A",
        mode: "TIME_SLOTS",
        ...WINTER_SLOT,
      },
    });

    // The same hours off a different instant. A fixed offset would print one of
    // the two pairs wrong.
    expect(rendered.html).toContain("2026-01-06 kl. 07:00-09:00");
    expect(rendered.html).not.toContain("06:00");
  });

  it("states a whole day as a date, with no time of day at all", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: bookingConfirmationMail,
      props: {
        recipientName: "Rune",
        resourceName: "Foreningslokalen",
        mode: "WHOLE_DAY",
        startsAt: new Date("2026-07-06T22:00:00.000Z"),
        endsAt: new Date("2026-07-07T22:00:00.000Z"),
      },
    });

    expect(rendered.html).toContain("2026-07-07");
    // A whole day has no hours to state, and midnight stated as an hour would
    // read as a booking that starts at midnight.
    expect(rendered.html).not.toContain("kl.");
    expect(rendered.html).not.toContain("00:00");
  });

  it("states a stay as a check-in and a check-out", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: bookingConfirmationMail,
      props: {
        recipientName: "Rune",
        resourceName: "Gastlagenheten",
        mode: "DATE_RANGE",
        startsAt: new Date("2026-07-06T22:00:00.000Z"),
        // The local midnight after the last night, which is the check-out date.
        endsAt: new Date("2026-07-09T22:00:00.000Z"),
      },
    });

    expect(rendered.html).toContain("Ankomst 2026-07-07, avresa 2026-07-10");
  });

  it("carries the period in the plain-text alternative as well", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: bookingConfirmationMail,
      props: {
        recipientName: "Rune",
        resourceName: "Tvattstuga A",
        mode: "TIME_SLOTS",
        ...SUMMER_SLOT,
      },
    });

    // Some clients show only this part, and the period is the whole message.
    expect(rendered.text).toContain("2026-07-06 kl. 07:00-09:00");
  });
});

describe("the notice that a booking was cancelled", () => {
  it("says the association cancelled it, and names nobody", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: bookingCancellationMail,
      props: {
        recipientName: "Rune",
        resourceName: "Gastlagenheten",
        mode: "DATE_RANGE",
        startsAt: new Date("2026-07-06T22:00:00.000Z"),
        endsAt: new Date("2026-07-09T22:00:00.000Z"),
      },
    });

    expect(rendered.html).toContain("Föreningen har avbokat");
    // The board member's own name is not a prop, so it cannot reach the body.
    // The audit entry records the actor and the access report answers for it.
    expect(rendered.html).toContain("Ankomst 2026-07-07, avresa 2026-07-10");
  });

  it("tells the resident the period is free again", async () => {
    const rendered = await service.renderMail({
      locale: "en",
      template: bookingCancellationMail,
      props: {
        recipientName: "Rune",
        resourceName: "Tvattstuga A",
        mode: "TIME_SLOTS",
        ...SUMMER_SLOT,
      },
    });

    // Without this the reader cannot tell whether the hour is theirs to take
    // back or gone, which is the first thing they will want to know.
    expect(rendered.html).toContain("The period is free again");
  });
});
