import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { Env } from "../../config/env";
import type { PrismaService } from "../../database/prisma.service";
import { I18nService } from "../../i18n/i18n.service";
import type { MailSettingsResolver } from "../mail-settings";
import { MailService } from "../mail.service";
import { brokerUpdateRequestAccessReportMail } from "./broker-update-request-access-report.template";
import { brokerUpdateRequestNoticeMail } from "./broker-update-request-notice.template";

/**
 * The two mails about a broker's update request: the board's notice, which
 * says that a broker asked and nothing about who, and the extract a broker
 * asking what is held about them is sent, which says everything.
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

const RECEIVED_AT = new Date("2026-10-12T09:30:00.000Z");

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

describe("the board's notice", () => {
  it("names the apartment and links to the queue", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: brokerUpdateRequestNoticeMail,
      props: {
        recipientName: "Bo Ek",
        apartmentReference: "LGH 1101",
        receivedAt: RECEIVED_AT,
      },
    });

    expect(rendered.subject).toBe(
      "En mäklare bad styrelsen se över uppgifterna på mäklarsidan",
    );
    expect(rendered.text).toContain("om lägenhet LGH 1101");
    expect(rendered.html).toContain(
      'href="https://brf.example.se/app/board/settings/account-requests"',
    );
  });

  it("says nothing about an apartment the broker did not name", async () => {
    const rendered = await service.renderMail({
      locale: "en",
      template: brokerUpdateRequestNoticeMail,
      props: {
        recipientName: "Bo Ek",
        apartmentReference: null,
        receivedAt: RECEIVED_AT,
      },
    });

    expect(rendered.text).toContain("A broker asked on");
    expect(rendered.text).not.toContain("apartment ");
  });

  it("can carry no contact detail, because its props hold none", () => {
    // A prop added for the broker's name or address would have to be named
    // here, in review, before a body could print it.
    const props: Parameters<typeof brokerUpdateRequestNoticeMail.subject>[0] = {
      recipientName: "Bo Ek",
      apartmentReference: null,
      receivedAt: RECEIVED_AT,
    };
    expect(Object.keys(props).toSorted()).toEqual([
      "apartmentReference",
      "receivedAt",
      "recipientName",
    ]);
  });
});

describe("the extract a broker is sent", () => {
  it("prints every request as it is held, with its answer and deletion day", async () => {
    const rendered = await service.renderMail({
      locale: "sv",
      template: brokerUpdateRequestAccessReportMail,
      props: {
        email: "mia@maklarbyran.example",
        requests: [
          {
            receivedAt: RECEIVED_AT,
            name: "Mia Mäklare",
            brokerage: "Mäklarbyrån AB",
            apartmentReference: "LGH 1101",
            note: "Säljstart nästa vecka.",
            answeredAt: new Date("2026-10-15T08:00:00.000Z"),
            deletedBy: new Date("2026-11-15T08:00:00.000Z"),
          },
          {
            receivedAt: RECEIVED_AT,
            name: null,
            brokerage: null,
            apartmentReference: null,
            note: null,
            answeredAt: null,
            deletedBy: new Date("2027-01-11T09:30:00.000Z"),
          },
        ],
      },
    });

    expect(rendered.subject).toBe(
      "Vad Brf Eksemplet har om dina förfrågningar",
    );
    expect(rendered.text).toContain("2 förfrågningar");
    expect(rendered.text).toContain("mia@maklarbyran.example");
    for (const held of [
      "Mia Mäklare",
      "Mäklarbyrån AB",
      "LGH 1101",
      "Säljstart nästa vecka.",
      "Besvarad av styrelsen",
      "Ännu inte besvarad av styrelsen",
      "inte angivet",
      "Tas bort senast",
    ]) {
      expect(rendered.text).toContain(held);
    }
    // The broker is in no address book.
    expect(rendered.text).not.toContain("adressboken");
    expect(rendered.text).toContain("eftersom du har frågat");
  });

  it("says so when nothing is held under the address", async () => {
    const rendered = await service.renderMail({
      locale: "en",
      template: brokerUpdateRequestAccessReportMail,
      props: { email: "per@maklarbyran.example", requests: [] },
    });

    expect(rendered.text).toContain(
      "Brf Eksemplet holds no request to look at the facts on its broker information page sent from per@maklarbyran.example.",
    );
  });
});
