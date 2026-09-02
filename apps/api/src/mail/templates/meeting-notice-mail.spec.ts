import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "../../config/env";
import type { FieldEncryptionService } from "../../crypto/field-encryption.service";
import type { PrismaService } from "../../database/prisma.service";
import { I18nService } from "../../i18n/i18n.service";
import { MailService } from "../mail.service";
import {
  type MeetingNoticeMailKind,
  meetingNoticeMail,
} from "./meeting-notice.template";

/**
 * What the notice says about the kind of meeting it summons.
 *
 * Rendered for real rather than against a stubbed translator, because the
 * property under test is a property of the sentence: the same term reads one way
 * as a heading and another inside running text, and only the output shows which
 * one each place got.
 *
 * The screens' term is a heading - capitalised, with no article - and that is
 * what the subject line and the mail's own heading want. Interpolated into the
 * body it is wrong twice over: English needs an article and neither language
 * capitalises a common noun mid-sentence. A notice is the one message in the
 * product that is the document rather than a pointer to one, so its wording is
 * what the member is summoned by.
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

/** 18:30 on a spring evening, when Sweden is two hours ahead of UTC. */
const STARTS_AT = new Date("2029-05-17T16:30:00.000Z");

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

function render(locale: "sv" | "en", kind: MeetingNoticeMailKind) {
  return service.renderMail({
    locale,
    template: meetingNoticeMail,
    props: {
      recipientName: "Astrid",
      kind,
      startsAt: STARTS_AT,
      place: "Foreningslokalen",
      digitalParticipation: null,
      agenda: ["Stammans oppnande"],
    },
  });
}

describe("the notice for a general meeting", () => {
  it("summons the members to an ordinary general meeting in English", async () => {
    const rendered = await render("en", "ORDINARY");

    expect(rendered.text).toContain(
      "hereby summons the members to an ordinary general meeting.",
    );
    // The heading's own form, which is what the article would not agree with.
    expect(rendered.text).not.toContain("to a Ordinary");
    expect(rendered.text).not.toContain("to an Ordinary");
  });

  it("summons the members to an extraordinary general meeting in English", async () => {
    const rendered = await render("en", "EXTRAORDINARY");

    expect(rendered.text).toContain(
      "hereby summons the members to an extraordinary general meeting.",
    );
    expect(rendered.text).not.toContain("to a Extraordinary");
  });

  it("summons the members in Swedish without capitalising the term", async () => {
    // Swedish needs no article here and the same lowercase form: a common noun
    // mid-sentence is not capitalised, so the heading's term is wrong here too.
    const swedish = await render("sv", "ORDINARY");

    expect(swedish.text).toContain(
      "kallar härmed medlemmarna till ordinarie föreningsstämma.",
    );
    expect(swedish.text).not.toContain("till Ordinarie");

    const extra = await render("sv", "EXTRAORDINARY");
    expect(extra.text).toContain(
      "kallar härmed medlemmarna till extra föreningsstämma.",
    );
    expect(extra.text).not.toContain("till Extra");
  });

  it("keeps the heading and the subject line as headings", async () => {
    // The sentence form is for the sentence. A subject line and a heading name
    // the meeting, and there the screens' own term is the right one - which is
    // also what keeps the notice and the meeting screen calling it one thing.
    const english = await render("en", "ORDINARY");
    const swedish = await render("sv", "EXTRAORDINARY");

    expect(english.subject).toBe(
      "Ordinary general meeting on 05/17/2029 - Brf Eksemplet",
    );
    expect(english.html).toContain("Ordinary general meeting");
    expect(swedish.subject).toBe(
      "Extra föreningsstämma den 2029-05-17 - Brf Eksemplet",
    );
    expect(swedish.html).toContain("Extra föreningsstämma");
  });
});
