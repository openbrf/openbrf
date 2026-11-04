import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { Env } from "../../config/env";
import type { PrismaService } from "../../database/prisma.service";
import { I18nService } from "../../i18n/i18n.service";
import type { MailSettingsResolver } from "../mail-settings";
import { MailService } from "../mail.service";
import {
  type IssueHandlerNoticeEvent,
  issueHandlerNoticeMail,
} from "./issue-handler-notice.template";
import { issueReporterNoticeMail } from "./issue-reporter-notice.template";

/**
 * The mails about an issue: the number, the type, the priority and a link,
 * and nothing anybody wrote (decision 21 of the issue module plan). What the
 * flows put into them is held to that in `issue-mail.int-spec.ts`.
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

const EVENTS: readonly IssueHandlerNoticeEvent[] = [
  "assigned",
  "filed",
  "urgent",
  "overdue",
  "reopened",
  "message",
];

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
    // Rendering never asks where the mail goes.
    {} as MailSettingsResolver,
  );
});

describe("the handler's mail", () => {
  it.each(
    EVENTS.flatMap((event) => [
      { event, locale: "sv" },
      { event, locale: "en" },
    ]),
  )(
    "names the number, the type and the priority and links to the queue ($event, $locale)",
    async ({ event, locale }) => {
      const rendered = await service.renderMail({
        locale,
        template: issueHandlerNoticeMail,
        props: {
          recipientName: "Bo Ek",
          event,
          number: 4711,
          typeName: "Vattenläcka",
          priority: "URGENT",
          targetDate: event === "overdue" ? new Date("2028-02-29") : null,
        },
      });

      expect(rendered.subject).toContain("4711");
      expect(rendered.subject).toContain("Vattenläcka");
      expect(rendered.text).toContain(locale === "sv" ? "Akut" : "Urgent");
      expect(rendered.html).toContain(
        'href="https://brf.example.se/app/board/issues"',
      );
      // Every string resolved: a missing key renders as the key itself.
      for (const part of [rendered.subject, rendered.text]) {
        expect(part).not.toMatch(/email\.issue|issues\.priority/);
      }
    },
  );

  it("says the day the issue was meant to be done by, on 29 February too", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: issueHandlerNoticeMail,
      props: {
        recipientName: "Bo Ek",
        event: "overdue",
        number: 12,
        typeName: "Hiss",
        priority: "NORMAL",
        targetDate: new Date("2028-02-29"),
      },
    });

    expect(rendered.subject).toBe("Ärende 12 har passerat senast klart: Hiss");
    expect(rendered.text).toContain("senast 2028-02-29");
  });
});

describe("the reporter's mail", () => {
  it.each(["sv", "en"])(
    "names the number and the type, links to their own issues and leaves the priority out (%s)",
    async (locale) => {
      const rendered = await service.renderMail({
        locale,
        template: issueReporterNoticeMail,
        props: { recipientName: "Rune Boende", number: 33, typeName: "Hiss" },
      });

      expect(rendered.subject).toContain("33");
      expect(rendered.subject).toContain("Hiss");
      expect(rendered.html).toContain(
        'href="https://brf.example.se/app/issues"',
      );
      // The priority is the handlers' own (decisions 9 and 11).
      expect(rendered.text).not.toMatch(/Prioritet|Priority|Akut|Urgent/);
    },
  );
});
