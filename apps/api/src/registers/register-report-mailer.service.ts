import { Injectable, Logger } from "@nestjs/common";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { failureName } from "../logging/failure";
import { MailService } from "../mail/mail.service";
import { registerReportObligationMail } from "../mail/templates";

/**
 * Telling the board that a reporting window has opened.
 *
 * A deadline entered in the ledger nobody is told about is a deadline nobody
 * meets. Lag (2026:484) 3 kap. gives two weeks and 3 kap. 10 § lets Lantmateriet
 * order a late report in under penalty of a fine, so the message goes out when
 * the window opens rather than being left for whoever next opens the queue.
 *
 * ## A failed send never leaves this method
 *
 * The loop catches per board member, so one unreachable address does not abandon
 * the seats after it: a rejection that escaped would leave the board members
 * before the failure notified and the ones after it not, with nothing saying
 * which. That catch is also what keeps a mail outage away from the register
 * write, since the caller sends after its transaction has committed and a
 * rejection reaching it would report a written register as a failure.
 *
 * It is not the only thing standing there. Resolving the recipients at all is a
 * database read, and a failure before the loop would escape this method; the
 * caller therefore wraps the call as well, and both layers are covered by tests
 * of their own. The argument for the ordering is at the call site, in
 * `apartment-register.service.ts`, which is where it belongs.
 *
 * The method returns how many board members were written to, the way the move
 * flows do, so a caller can report "recorded, nobody notified" rather than
 * reporting a written register as a failure.
 *
 * ## The address is decrypted per send and never held
 *
 * A recipient is resolved from their person row each time a message goes out and
 * the plaintext address lives in one local for the length of the call. It is
 * never a field on this service and never in a log line: only the person id and
 * the obligation id are, which is the convention `logging/failure.ts` sets out.
 * A mail server refusing a recipient quotes the envelope back, and that envelope
 * holds an address decrypted a few lines earlier.
 *
 * ## The locale is the recipient's own
 *
 * Read off each board member's row rather than taken from whoever recorded the
 * register event. A board with a Swedish chair and an English-reading treasurer
 * gets one message each in their own language, and the message names the
 * register event through a locale key rather than as a rendered word so the
 * whole sentence follows the recipient.
 */
@Injectable()
export class RegisterReportMailerService {
  private readonly logger = new Logger(RegisterReportMailerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
  ) {}

  /**
   * Tells the board that one duty now exists.
   *
   * @returns How many board members the message reached.
   */
  async sendObligationNotice(input: {
    obligationId: string;
    kind: "TRANSFER" | "TERMINATION";
    designation: string;
    triggeredOn: Date;
    dueOn: Date;
    now?: Date;
  }): Promise<number> {
    const now = input.now ?? new Date();

    const board = await this.prisma.person.findMany({
      where: {
        // A seat with an end date in the future is still held, which is how
        // every other reader of this table decides.
        boardPositions: {
          some: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
        },
        emailCipher: { not: null },
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });

    let sent = 0;
    for (const member of board) {
      if (member.emailCipher === null) {
        continue;
      }
      try {
        const to = await this.encryption.decrypt(
          "person.email",
          member.emailCipher,
        );
        await this.mail.send({
          to,
          locale: member.preferredLocale,
          template: registerReportObligationMail,
          props: {
            recipientName: `${member.firstName} ${member.lastName}`.trim(),
            kind: input.kind,
            designation: input.designation,
            triggeredOn: input.triggeredOn,
            dueOn: input.dueOn,
          },
        });
        sent += 1;
      } catch (error) {
        // Named by person id, obligation id and the class of the failure, never
        // by address and never by the failure's own payload: this loop decrypts
        // an address and hands it to a mail server, which quotes it back.
        this.logger.error(
          `Reporting obligation notice failed for board member ${member.id} ` +
            `on obligation ${input.obligationId}: ` +
            failureName(error),
        );
      }
    }

    this.logger.log(
      `Reporting obligation ${input.obligationId} notified to ${String(sent)} board members`,
    );
    return sent;
  }
}
