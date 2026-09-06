import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "../../config/env";
import type { FieldEncryptionService } from "../../crypto/field-encryption.service";
import type { PrismaService } from "../../database/prisma.service";
import { I18nService } from "../../i18n/i18n.service";
import { MailService } from "../mail.service";
import { breachReminderMail } from "./personal-data-breach-reminder.template";

/**
 * What the reminder says, and what it does not.
 *
 * Rendered for real rather than against a stubbed translator, because both
 * properties under test are properties of the sentence. The deadline has to
 * read as GDPR art. 33(1) states it - without undue delay and, where feasible,
 * within 72 hours - rather than as a flat "within 72 hours", which would tell a
 * board it may wait 71 of them.
 *
 * And the message must carry the title and nothing else about the breach. What
 * it touched, whose data it was and how many people it reached are on the
 * record behind the link; a mailbox is not the register, and a reminder that
 * summarised the breach would put its worst details on every board member's
 * telephone.
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

const DISCOVERED_AT = new Date("2026-09-07T08:30:00.000Z");
const NOTIFY_BY = new Date("2026-09-10T08:30:00.000Z");

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

function render(locale: "sv" | "en") {
  return service.renderMail({
    locale,
    template: breachReminderMail,
    props: {
      recipientName: "Astrid",
      breachTitle: "Felskickad medlemslista",
      discoveredAt: DISCOVERED_AT,
      notifyBy: NOTIFY_BY,
    },
  });
}

describe("the breach reminder", () => {
  it("states the deadline as the article does, in Swedish", async () => {
    const rendered = await render("sv");

    expect(rendered.text).toContain("utan onödigt dröjsmål");
    expect(rendered.text).toContain("72 timmar");
  });

  it("states it the same way in English", async () => {
    const rendered = await render("en");

    expect(rendered.text).toContain("without undue delay");
    expect(rendered.text).toContain("72 hours");
  });

  it("names the breach and says nothing else about it", async () => {
    const rendered = await render("sv");

    expect(rendered.subject).toContain("Felskickad medlemslista");
    // The register is behind the link; the mail is a pointer to it.
    expect(rendered.text).toContain("/data-protection");

    /*
     * The "nothing else" half, asserted as absence. `breachReminderMail` takes
     * no prop carrying these, so the values the record holds are what the body
     * is checked against: a later prop that appended the data description or
     * the affected count would then trip this case rather than pass it, and the
     * worst details of a breach would not reach a mailbox unnoticed.
     */
    const body = `${rendered.subject}\n${rendered.text}`;
    for (const withheld of [
      "medlemsregistret",
      "personnummer",
      "e-postadresser",
      "42",
    ]) {
      expect(body).not.toContain(withheld);
    }
  });

  it("says a decision is still owed, so the reminder reads as one", async () => {
    const swedish = await render("sv");
    const english = await render("en");

    expect(swedish.text).toContain("beslut");
    expect(english.text).toContain("decided");
  });
});
