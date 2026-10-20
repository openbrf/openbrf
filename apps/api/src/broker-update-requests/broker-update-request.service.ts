import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { type ActorContext, auditActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { normalizeEmail } from "../crypto/personal-data";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import { MailService } from "../mail/mail.service";
import {
  type BrokerUpdateRequestExtract,
  brokerUpdateRequestAccessReportMail,
} from "../mail/templates";
import { lockAssociationFacts } from "../site/association-facts-lock";
import {
  type FactsConfirmedEvent,
  readAssociationFacts,
} from "../site/association-facts.service";
import { updatesRequestable } from "../site/facts-currency";
import { BrokerUpdateRequestNoticeService } from "./broker-update-request-notice.service";
import {
  ANSWERED_RETENTION_DAYS,
  RECEIVED_RETENTION_DAYS,
} from "./broker-update-request-retention";

/**
 * A broker's request that the board look at the facts on the broker
 * information page again, from the form to the board's queue.
 *
 * The page offers the form once the facts are older than the board's own
 * threshold (`site/facts-currency.ts`). What it sends is a request and nothing
 * more: no fact is released, no answer is mailed to the broker, and nothing
 * changes on the page. The board is told a request has arrived, without the
 * broker's details (`broker-update-request-notice.service.ts`). It answers by
 * confirming or editing the facts on its own screen, which marks every open
 * request answered in the same transaction, and reaches the broker itself if
 * it wants to.
 *
 * ## The limits
 *
 * The form is public, so what it costs to send is the only thing between the
 * board's queue and a script. In front of everything is the route's own limit
 * per client address (`PublicRateLimit`), in memory: the client address is
 * used for that and stored nowhere, which is what the data protection note
 * asks (docs/broker-package-data-protection.md). Behind it, four limits
 * counted from this table, so that a restart starts none of them over:
 *
 *   - one open request per apartment reference at a time,
 *   - three per apartment reference in thirty days,
 *   - five per broker address in a day,
 *   - twenty in a day from everybody together.
 *
 * The first two answer exactly as a stored request does. A broker asking about
 * an apartment somebody already asked about has been heard, and telling them
 * otherwise would tell a stranger that another broker is working on that
 * apartment. The last two are refused as too many, and are what bound the
 * queue whoever is sending: a script that changes its address and its
 * apartment with every request still meets the day's total. Twenty is far
 * more than the sales of a cooperative of twenty to two hundred households
 * produce in a year, let alone a day.
 *
 * ## One lock for the rule and the limits
 *
 * Every request takes the facts' own lock before it reads anything, and so
 * does every confirmation. That one key serialises two things. The staleness
 * check and the insert are about the same moment, so a confirmation cannot
 * commit between them and leave an open request over facts the board has just
 * confirmed. And two requests cannot both count the same limit below its edge
 * and both be stored. A lock on a table this small, taken by a form a broker
 * fills in by hand, costs nobody anything.
 *
 * ## What is kept, and what is not
 *
 * What the data protection note lists and nothing more: the broker's address,
 * and their name and firm if they gave them, encrypted where they identify
 * the broker; the apartment as they wrote it; a short note. No phone number is
 * asked for. The apartment is never looked up in the register, so the form
 * answers the same for a number the association has and one it does not.
 * Retention is in `broker-update-request-retention.ts`.
 *
 * The audit entries name a request and never what is in it. The log is
 * append-only and exempt from every purge, so a broker's address copied into it
 * would outlive the request it came on, and an apartment named there would say
 * for good that somebody was preparing to sell it.
 *
 * ## What a broker is told they are held as
 *
 * The broker is nobody the register holds, so the data subject access report,
 * which is a person's, does not carry their requests: joining a request to a
 * person by the address would attribute it to whoever the register holds at
 * that address, and an address can be shared or change hands. A broker who
 * asks is answered by {@link BrokerUpdateRequestService.sendAccessReport}
 * instead, which mails everything held under an address to that address and
 * to no other. Delivering it there is what verifies who is asking.
 */

/** One open request per apartment reference: a second answers as stored. */
const OPEN_PER_APARTMENT = 1;

/** Requests per apartment reference over the window below. */
const PER_APARTMENT_IN_WINDOW = 3;
const APARTMENT_WINDOW_DAYS = 30;

/** Requests per broker address in a day. */
const PER_EMAIL_PER_DAY = 5;

/** Requests from everybody together in a day. */
const ALL_PER_DAY = 20;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many requests of each kind the board's queue hands over at once.
 *
 * Far more than an association has. The limits above, the retention and the
 * one open request per apartment keep the table small; the bound is for the
 * day somebody gets past all three.
 */
export const QUEUE_PAGE_SIZE = 200;

/** What a broker sent, once the form has read it. */
export interface BrokerUpdateRequestInput {
  name?: string;
  email: string;
  brokerage?: string;
  /** As typed. Normalised here, before it is counted. */
  apartmentReference?: string;
  note?: string;
}

/**
 * What became of a request.
 *
 * `duplicate` and `stored` are answered identically to the broker. `current`
 * is the facts having been confirmed since the page was read; `limited` is the
 * sender's own limit or the day's total.
 */
export type BrokerUpdateRequestOutcome =
  "stored" | "duplicate" | "current" | "limited";

/** One request, as the board reads it in its queue. */
export interface BrokerUpdateRequestView {
  id: string;
  /** Decrypted for the board, because answering the broker is the point. */
  name: string | null;
  email: string;
  brokerage: string | null;
  /** The apartment as the broker wrote it, or null when they named none. */
  apartmentReference: string | null;
  note: string | null;
  createdAt: string;
  /** When a confirmation answered it, or null while it is open. */
  answeredAt: string | null;
}

/** The board's queue: the open requests, and the answered ones still kept. */
export interface BrokerUpdateRequestQueue {
  open: BrokerUpdateRequestView[];
  answered: BrokerUpdateRequestView[];
  /** Every open request, whether or not this page holds it. */
  openTotal: number;
}

/** What a board member is told once the extract has gone. */
export interface BrokerUpdateRequestAccessReportSent {
  /** How many requests it held. */
  requests: number;
}

export class BrokerUpdateRequestError extends DomainError {
  readonly status = HttpStatus.NOT_FOUND;
  readonly reason = "not-found";
}

/**
 * The apartment reference as it is matched and counted.
 *
 * Trimmed, with each run of spaces as one and in capitals, so "lgh 1101" and
 * "LGH  1101" are one reference to the limits and to the board.
 */
export function normalizeApartmentReference(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

@Injectable()
export class BrokerUpdateRequestService {
  private readonly logger = new Logger(BrokerUpdateRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
    private readonly notices: BrokerUpdateRequestNoticeService,
    private readonly mail: MailService,
  ) {}

  /**
   * Takes a broker's request, or says why not.
   *
   * Encrypted before the transaction, so the lock is held for the reads and
   * the insert and not for the key derivation. The staleness rule is asked
   * again under the lock rather than trusted from the page: see the module
   * comment.
   *
   * The board's notice is queued by the same transaction as the row, so it
   * exists exactly when a request was stored and runs once that has
   * committed. A duplicate or a refusal stores nothing and queues nothing.
   */
  async submit(
    input: BrokerUpdateRequestInput,
    now: Date = new Date(),
  ): Promise<BrokerUpdateRequestOutcome> {
    const apartmentReference =
      input.apartmentReference === undefined
        ? null
        : normalizeApartmentReference(input.apartmentReference);
    const [name, email] = await Promise.all([
      input.name === undefined
        ? null
        : this.encryption.encrypt("brokerUpdateRequest.name", input.name),
      this.encryption.encrypt("brokerUpdateRequest.email", input.email),
    ]);

    await this.notices.ensureQueues();

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockAssociationFacts(tx);

      if (!updatesRequestable(await readAssociationFacts(tx), now)) {
        return { kind: "current" } as const;
      }

      const limit = await this.limitReached(tx, {
        apartmentReference,
        emailIndex: email.index,
        now,
      });
      if (limit !== null) {
        return { kind: limit } as const;
      }

      const row = await tx.brokerUpdateRequest.create({
        data: {
          nameCipher: name?.cipher ?? null,
          emailCipher: email.cipher,
          emailIndex: email.index,
          brokerage: input.brokerage ?? null,
          apartmentReference,
          note: input.note ?? null,
        },
        select: { id: true },
      });

      await this.audit.record(
        {
          action: "BROKER_UPDATE_REQUEST_RECEIVED",
          // From the website, by somebody with no account: nobody to name.
          channel: "WEB",
          actorPersonId: null,
          targetKind: "brokerUpdateRequest",
          targetId: row.id,
        },
        tx,
      );

      await this.notices.enqueueInTransaction(tx, row.id);

      return { kind: "stored", id: row.id } as const;
    });

    // The identifier, or the reason. Never what was sent or who sent it.
    if (outcome.kind === "stored") {
      this.logger.log(`Stored broker update request ${outcome.id}`);
    } else {
      this.logger.log(`Did not store a broker update request: ${outcome.kind}`);
    }
    return outcome.kind;
  }

  /**
   * The board's queue: open requests oldest first, then the answered ones it
   * still keeps, most recently answered first.
   */
  async list(): Promise<BrokerUpdateRequestQueue> {
    const select = {
      id: true,
      nameCipher: true,
      emailCipher: true,
      brokerage: true,
      apartmentReference: true,
      note: true,
      createdAt: true,
      answeredAt: true,
    } satisfies Prisma.BrokerUpdateRequestSelect;

    const [open, answered, openTotal] = await Promise.all([
      this.prisma.brokerUpdateRequest.findMany({
        where: { answeredAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: QUEUE_PAGE_SIZE,
        select,
      }),
      this.prisma.brokerUpdateRequest.findMany({
        where: { answeredAt: { not: null } },
        orderBy: [{ answeredAt: "desc" }, { id: "asc" }],
        take: QUEUE_PAGE_SIZE,
        select,
      }),
      this.prisma.brokerUpdateRequest.count({ where: { answeredAt: null } }),
    ]);

    return {
      open: await Promise.all(open.map((row) => this.viewOf(row))),
      answered: await Promise.all(answered.map((row) => this.viewOf(row))),
      openTotal,
    };
  }

  /**
   * Deletes a request the board has decided is not one - spam, a mistake, a
   * broker who asked to be forgotten - and records that it did.
   *
   * Deleted rather than marked, because a request somebody has decided not to
   * answer has no purpose left to keep the broker's details for. Open or
   * answered alike.
   */
  async dismiss(id: string, actor: ActorContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.brokerUpdateRequest.deleteMany({
        where: { id },
      });
      if (count === 0) {
        // Gone already: another board member, or the purge, got there first.
        throw new BrokerUpdateRequestError("No such update request.");
      }

      await this.audit.record(
        {
          action: "BROKER_UPDATE_REQUEST_DISMISSED",
          ...auditActor(actor),
          targetKind: "brokerUpdateRequest",
          targetId: id,
        },
        tx,
      );
    });
  }

  /**
   * Mails a broker everything held under their address, and tells the board
   * member how many requests that was (GDPR art. 15).
   *
   * Found by the address's blind index, then by the address itself: the index
   * is short enough to be shared by two addresses, and a request from somebody
   * else must not reach this extract. Sent to the address as it is held on the
   * requests, or as the board member wrote it when there are none, and never
   * shown to the board member: see the module comment. An address with
   * nothing under it is mailed too, because that is an answer as well.
   *
   * The audit entry is written once the mail has gone, and records the act
   * and how many, never the address. Mailing it again sends the same extract
   * again, which is harmless.
   */
  async sendAccessReport(
    email: string,
    actor: ActorContext,
  ): Promise<BrokerUpdateRequestAccessReportSent> {
    const wanted = normalizeEmail(email);
    const index = await this.encryption.computeIndex(
      "brokerUpdateRequest.email",
      email,
    );
    const candidates =
      index === null
        ? []
        : await this.prisma.brokerUpdateRequest.findMany({
            where: { emailIndex: index },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: {
              nameCipher: true,
              emailCipher: true,
              brokerage: true,
              apartmentReference: true,
              note: true,
              createdAt: true,
              answeredAt: true,
            },
          });

    const held: { email: string; extract: BrokerUpdateRequestExtract }[] = [];
    for (const row of candidates) {
      const address = await this.encryption.decrypt(
        "brokerUpdateRequest.email",
        row.emailCipher,
      );
      if (normalizeEmail(address) !== wanted) {
        continue;
      }
      held.push({
        email: address,
        extract: {
          receivedAt: row.createdAt,
          name:
            row.nameCipher === null
              ? null
              : await this.encryption.decrypt(
                  "brokerUpdateRequest.name",
                  row.nameCipher,
                ),
          brokerage: row.brokerage,
          apartmentReference: row.apartmentReference,
          note: row.note,
          answeredAt: row.answeredAt,
          deletedBy: deletedBy(row),
        },
      });
    }

    const to = held[0]?.email ?? email.trim();
    await this.mail.send({
      to,
      // The broker's language is not known: the association's own.
      locale: null,
      template: brokerUpdateRequestAccessReportMail,
      props: { email: to, requests: held.map((entry) => entry.extract) },
    });

    await this.audit.record({
      action: "BROKER_UPDATE_REQUEST_ACCESS_REPORT_SENT",
      ...auditActor(actor),
      targetKind: "brokerUpdateRequest",
      context: { requests: held.length },
    });

    this.logger.log(
      `Sent a broker the ${String(held.length)} update requests held under their address`,
    );
    return { requests: held.length };
  }

  /**
   * Marks every open request answered by a confirmation, inside the
   * confirmation's own transaction.
   *
   * Registered with the facts service as its confirmation hook, so a save, a
   * confirmation and an edit through a connected app all answer the queue the
   * same way, and a confirmation that rolls back answers nothing. One entry for
   * the act, with the actor of the confirmation and how many it answered, and
   * none when there was nothing open.
   */
  async answerOpen(
    tx: Prisma.TransactionClient,
    event: FactsConfirmedEvent,
  ): Promise<number> {
    const { count } = await tx.brokerUpdateRequest.updateMany({
      where: { answeredAt: null },
      data: { answeredAt: event.confirmedAt },
    });
    if (count === 0) {
      return 0;
    }

    await this.audit.record(
      {
        action: "BROKER_UPDATE_REQUESTS_ANSWERED",
        ...auditActor(event.actor),
        targetKind: "brokerUpdateRequest",
        context: { requests: count },
      },
      tx,
    );
    return count;
  }

  /**
   * The limit this request would pass, or null when it passes them all.
   *
   * The refusals are asked first, so a sender over their own limit, or a day
   * that is full, is told to wait whichever apartment they asked about. An
   * address index that could not be computed counts nothing: the address was
   * valid to the form, and refusing a broker for the instance's own
   * normalisation would be the wrong failure. A request naming no apartment
   * meets no apartment limit, and still meets the other two.
   */
  private async limitReached(
    tx: Prisma.TransactionClient,
    keys: {
      apartmentReference: string | null;
      emailIndex: string | null;
      now: Date;
    },
  ): Promise<"limited" | "duplicate" | null> {
    const dayAgo = new Date(keys.now.getTime() - MILLISECONDS_PER_DAY);
    const windowStart = new Date(
      keys.now.getTime() - APARTMENT_WINDOW_DAYS * MILLISECONDS_PER_DAY,
    );

    const [fromEmail, all, openForApartment, forApartment] = await Promise.all([
      keys.emailIndex === null
        ? 0
        : tx.brokerUpdateRequest.count({
            where: {
              emailIndex: keys.emailIndex,
              createdAt: { gt: dayAgo },
            },
          }),
      tx.brokerUpdateRequest.count({ where: { createdAt: { gt: dayAgo } } }),
      keys.apartmentReference === null
        ? 0
        : tx.brokerUpdateRequest.count({
            where: {
              apartmentReference: keys.apartmentReference,
              answeredAt: null,
            },
          }),
      keys.apartmentReference === null
        ? 0
        : tx.brokerUpdateRequest.count({
            where: {
              apartmentReference: keys.apartmentReference,
              createdAt: { gt: windowStart },
            },
          }),
    ]);

    if (fromEmail >= PER_EMAIL_PER_DAY || all >= ALL_PER_DAY) {
      return "limited";
    }
    if (
      openForApartment >= OPEN_PER_APARTMENT ||
      forApartment >= PER_APARTMENT_IN_WINDOW
    ) {
      return "duplicate";
    }
    return null;
  }

  private async viewOf(row: {
    id: string;
    nameCipher: string | null;
    emailCipher: string;
    brokerage: string | null;
    apartmentReference: string | null;
    note: string | null;
    createdAt: Date;
    answeredAt: Date | null;
  }): Promise<BrokerUpdateRequestView> {
    const [name, email] = await Promise.all([
      row.nameCipher === null
        ? null
        : this.encryption.decrypt("brokerUpdateRequest.name", row.nameCipher),
      this.encryption.decrypt("brokerUpdateRequest.email", row.emailCipher),
    ]);
    return {
      id: row.id,
      name,
      email,
      brokerage: row.brokerage,
      apartmentReference: row.apartmentReference,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      answeredAt: row.answeredAt?.toISOString() ?? null,
    };
  }
}

/**
 * The latest moment the purge deletes a request.
 *
 * Due 90 days after it arrived, or 30 days after its answer when that comes
 * first, and deleted by the nightly purge's next run after that: a day on is
 * the latest that can be, and the extract states a day it can keep to.
 */
function deletedBy(row: { createdAt: Date; answeredAt: Date | null }): Date {
  const received =
    row.createdAt.getTime() + RECEIVED_RETENTION_DAYS * MILLISECONDS_PER_DAY;
  const due =
    row.answeredAt === null
      ? received
      : Math.min(
          received,
          row.answeredAt.getTime() +
            ANSWERED_RETENTION_DAYS * MILLISECONDS_PER_DAY,
        );
  return new Date(due + MILLISECONDS_PER_DAY);
}
