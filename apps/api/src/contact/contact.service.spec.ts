import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import type { MailService } from "../mail/mail.service";
import { ContactError } from "./contact.error";
import { ContactService } from "./contact.service";

/**
 * The board's inbox cursor, as a reader can hand it back.
 *
 * The cursor is plain text the service issued itself, so anything else is a
 * place in the inbox that is not there. Reading it as the first page instead
 * would hand a board that is reading on the messages it already has, so each
 * of these has to be refused, and refused before the database is asked.
 */

function serviceOverFakeDatabase() {
  const findMany = vi.fn();
  const count = vi.fn();
  const prisma = {
    contactSubmission: { findMany, count },
  } as unknown as PrismaService;
  const service = new ContactService(
    { NODE_ENV: "test" } as Env,
    prisma,
    {} as FieldEncryptionService,
    {} as MailService,
    {} as JobQueueService,
  );
  return { service, findMany, count };
}

const INSTANT = "2026-03-01T10:00:00.000Z";

const MALFORMED_CURSORS: ReadonlyArray<[string, string]> = [
  ["garbage", "not-a-cursor"],
  ["an empty string", ""],
  ["a bad date", "open|yesterday|submission-1"],
  ["a date that only new Date tolerates", "open|2026-03-01|submission-1"],
  ["a missing id", `open|${INSTANT}`],
  ["an empty id", `open|${INSTANT}|`],
  ["an unknown state", `archived|${INSTANT}|submission-1`],
  ["an extra segment", `open|${INSTANT}|submission-1|more`],
];

describe("ContactService.list with a malformed cursor", () => {
  it.each(MALFORMED_CURSORS)(
    "refuses %s as not found without querying",
    async (_name, cursor) => {
      const { service, findMany, count } = serviceOverFakeDatabase();

      const refusal = await service
        .list(cursor)
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(ContactError);
      expect((refusal as ContactError).reason).toBe("not-found");
      expect(findMany).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    },
  );

  it("reads a cursor it issued, so the refusals above are not a blanket", async () => {
    const { service, findMany, count } = serviceOverFakeDatabase();
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    const page = await service.list(`handled|${INSTANT}|submission-1`);

    expect(page.submissions).toEqual([]);
    expect(findMany).toHaveBeenCalledOnce();
  });
});
