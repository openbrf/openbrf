import { Injectable, Logger } from "@nestjs/common";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { BookingResourceMode } from "../generated/prisma/enums";
import { MailService } from "../mail/mail.service";
import {
  bookingCancellationMail,
  bookingConfirmationMail,
} from "../mail/templates";

/** What one booking mail has to say, whichever of the two it is. */
export interface BookingMailInput {
  bookingId: string;
  /** The person who made the booking, and the only person written to. */
  bookedByPersonId: string;
  resourceName: string;
  /**
   * The schema's mode, handed to the templates as their own narrower union.
   * The assignment is the check: a mode added to the enum and not answered by
   * the period sentence fails the build here rather than rendering the wrong
   * shape.
   */
  mode: BookingResourceMode;
  startsAt: Date;
  endsAt: Date;
}

/** A resolved recipient: an address that exists only for the length of a send. */
interface Recipient {
  to: string;
  locale: string;
  name: string;
}

/**
 * The two booking mails: a confirmation, and a notice that somebody else
 * cancelled.
 *
 * ## Mail, and no SMS
 *
 * The platform has an SMS adapter, and this module deliberately does not reach
 * for it. A text message costs the association money per segment, every
 * booking would send one, and no pilot has asked for it - a laundry hour is not
 * worth a charge on the association's account. Nothing here is written so that
 * a channel flag could be added later either: adding one would be adding a
 * second delivery path, and that is the change to argue for at the time.
 *
 * ## The address is decrypted per send and never held
 *
 * A recipient is resolved from their person row each time a message goes out,
 * and the plaintext address lives in one local for the length of the call. It
 * is never a field on this service, never in a job payload, and never in a log
 * line - only the person id and the booking id are, which is the convention
 * `logging/failure.ts` sets out.
 *
 * ## The recipient's own language
 *
 * `preferredLocale` comes off the recipient's row, not from the principal who
 * acted. A board member working in English cancelling a Swedish household's
 * booking sends a Swedish message, because which language a person is written
 * to in is theirs.
 *
 * ## Failure is the caller's to swallow
 *
 * Nothing here catches. The two callers send after their transaction has
 * committed and wrap the call, so a mail server that is down is logged and the
 * booking stands - see the comments at those two call sites, which is where the
 * argument for that ordering belongs.
 */
@Injectable()
export class BookingMailerService {
  private readonly logger = new Logger(BookingMailerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
  ) {}

  /**
   * Confirms a booking to whoever made it.
   *
   * The booker alone, and not the household. Joint holders of one apartment
   * share the allowance the booking was counted against, but the booking is one
   * person's own act and mailing everybody who lives at an address would be a
   * broadcast nobody asked for - and it would tell a partner which hours the
   * other one keeps.
   *
   * @returns Whether a message went out. False means the recipient has no
   *   address on file, which is not a failure: a resident who has never been
   *   invited has none, and they booked through a screen that already told them
   *   it worked.
   */
  async sendConfirmation(booking: BookingMailInput): Promise<boolean> {
    const recipient = await this.recipientOf(booking.bookedByPersonId);
    if (recipient === null) {
      return false;
    }

    await this.mail.send({
      to: recipient.to,
      locale: recipient.locale,
      template: bookingConfirmationMail,
      props: {
        recipientName: recipient.name,
        resourceName: booking.resourceName,
        mode: booking.mode,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
      },
    });
    this.logger.log(`Confirmation sent for booking ${booking.bookingId}`);
    return true;
  }

  /**
   * Tells the person whose booking it was that somebody else cancelled it.
   *
   * ## Who gets this, and who does not
   *
   * Only the person who made the booking, and only when the cancellation was
   * not their own act.
   *
   * A resident cancelling their own booking is telling themselves. They pressed
   * the button, the screen answered, and the hour they gave up is one they no
   * longer wanted - a message saying so is a message about nothing, and a
   * household that books the laundry every week would get one every week.
   *
   * A board member or an administrator cancelling on somebody's behalf is the
   * opposite: the household planned around an hour that has been taken away by
   * a decision they were not part of, and nothing else in the platform would
   * tell them. The guest apartment booked for a visit in three weeks is the
   * case that matters - without this message the household finds out when they
   * open the calendar, which may be after the visitors have arrived.
   *
   * The test is the actor against the booker rather than which route was used.
   * A board member cancelling their own booking through the board's route is
   * still telling themselves, and `bookings:manage` is the capability the
   * administrator holds too, so a route-shaped test would mail the wrong half
   * of the cases.
   *
   * @returns Whether a message went out. False for the recipient's own
   *   cancellation, and for a recipient with no address on file.
   */
  async sendCancellation(
    booking: BookingMailInput & { cancelledByPersonId: string },
  ): Promise<boolean> {
    if (booking.cancelledByPersonId === booking.bookedByPersonId) {
      return false;
    }

    const recipient = await this.recipientOf(booking.bookedByPersonId);
    if (recipient === null) {
      return false;
    }

    await this.mail.send({
      to: recipient.to,
      locale: recipient.locale,
      template: bookingCancellationMail,
      props: {
        recipientName: recipient.name,
        resourceName: booking.resourceName,
        mode: booking.mode,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
      },
    });
    this.logger.log(
      `Cancellation notice sent for booking ${booking.bookingId}`,
    );
    return true;
  }

  /**
   * The recipient, or null when there is nobody to write to.
   *
   * Read by id and tolerant of the row being gone, because a booking names the
   * person who made it as a plain string and holds no reference that could veto
   * their erasure: a purge run between the commit and this call leaves a
   * booking whose booker no longer exists, and that is the schema working as
   * intended rather than a state to throw over.
   *
   * `protectedPersonalData` is deliberately not read. It withholds a person's
   * details from other people, and the only person a booking mail reaches is
   * that person: writing to somebody about their own booking discloses nothing
   * about them to anybody, and a masked greeting on a resident's own
   * confirmation would be the protection working against the person it is for.
   */
  private async recipientOf(personId: string): Promise<Recipient | null> {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: {
        firstName: true,
        lastName: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });
    if (person === null || person.emailCipher === null) {
      return null;
    }

    return {
      to: await this.encryption.decrypt("person.email", person.emailCipher),
      locale: person.preferredLocale,
      name: `${person.firstName} ${person.lastName}`.trim(),
    };
  }
}
