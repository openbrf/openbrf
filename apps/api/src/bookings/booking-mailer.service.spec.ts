import { describe, expect, it, vi } from "vitest";

import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { MailService } from "../mail/mail.service";
import { BookingMailerService } from "./booking-mailer.service";

/**
 * Who a booking mail reaches, and what leaves the process with it.
 *
 * Four properties, and the first is the one the module had to decide. A
 * cancellation is only worth sending when it was not the recipient's own act:
 * a resident who pressed cancel is telling themselves, while a household whose
 * guest apartment the board took away has no other way to find out.
 *
 * The recipient's language comes off the recipient's row. Nothing here reads the
 * acting principal at all, which is asserted rather than assumed - the actor is
 * passed in, so a version that looked up their locale would be easy to write.
 *
 * The address is decrypted once per message and never kept, so two messages
 * cost two decryptions. A cache would pass every assertion about content and
 * would be exactly the state this service is written not to hold.
 *
 * A recipient with no address, and one whose row has been purged, are both
 * answered rather than thrown over. A booking names its booker as a plain
 * string precisely so that erasure is never vetoed, which means a booker who no
 * longer exists is a state the schema permits.
 */

const BOOKER = "person-booker";
const BOARD_MEMBER = "person-board";

const BOOKING = {
  bookingId: "booking-1",
  bookedByPersonId: BOOKER,
  resourceName: "Tvattstuga A",
  mode: "TIME_SLOTS" as const,
  startsAt: new Date("2026-07-06T05:00:00.000Z"),
  endsAt: new Date("2026-07-06T07:00:00.000Z"),
};

function build(
  person: {
    firstName: string;
    lastName: string;
    emailCipher: string | null;
    preferredLocale: string;
  } | null = {
    firstName: "Rune",
    lastName: "Boende",
    emailCipher: "cipher-for-rune",
    preferredLocale: "en",
  },
) {
  const findUnique = vi.fn().mockResolvedValue(person);
  const decrypt = vi.fn(
    async (_id: string, cipher: string) => `${cipher}@exempel.se`,
  );
  const send = vi.fn().mockResolvedValue(undefined);

  const service = new BookingMailerService(
    { person: { findUnique } } as unknown as PrismaService,
    { decrypt } as unknown as FieldEncryptionService,
    { send } as unknown as MailService,
  );

  return { service, findUnique, decrypt, send };
}

describe("the cancellation notice", () => {
  it("is not sent to a resident who cancelled their own booking", async () => {
    const { service, decrypt, send } = build();

    const sent = await service.sendCancellation({
      ...BOOKING,
      cancelledByPersonId: BOOKER,
    });

    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    // Nothing is decrypted either. The decision is taken before the address is
    // read, so a self-cancellation does not even touch the ciphertext.
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("is sent to the resident when somebody else cancelled it", async () => {
    const { service, send } = build();

    const sent = await service.sendCancellation({
      ...BOOKING,
      cancelledByPersonId: BOARD_MEMBER,
    });

    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: "cipher-for-rune@exempel.se",
      template: { id: "booking-cancellation" },
    });
  });

  it("reads only the booker's row, never the actor's", async () => {
    const { service, findUnique } = build();

    await service.sendCancellation({
      ...BOOKING,
      cancelledByPersonId: BOARD_MEMBER,
    });

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique.mock.calls[0]?.[0]).toMatchObject({
      where: { id: BOOKER },
    });
  });
});

describe("the confirmation", () => {
  it("goes to the person who made the booking", async () => {
    const { service, send } = build();

    const sent = await service.sendConfirmation(BOOKING);

    expect(sent).toBe(true);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: "cipher-for-rune@exempel.se",
      template: { id: "booking-confirmation" },
      props: {
        recipientName: "Rune Boende",
        resourceName: "Tvattstuga A",
        mode: "TIME_SLOTS",
      },
    });
  });

  it("carries the period as instants, for the template to read locally", async () => {
    const { service, send } = build();

    await service.sendConfirmation(BOOKING);

    // The instants and not a formatted string: which wall clock a booking reads
    // as depends on the recipient's locale, which only the template knows.
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      props: { startsAt: BOOKING.startsAt, endsAt: BOOKING.endsAt },
    });
  });
});

describe("what a send costs", () => {
  it("writes in the recipient's own language and not a default", async () => {
    const { service, send } = build({
      firstName: "Rune",
      lastName: "Boende",
      emailCipher: "cipher-for-rune",
      preferredLocale: "en",
    });

    await service.sendConfirmation(BOOKING);

    expect(send.mock.calls[0]?.[0]).toMatchObject({ locale: "en" });
  });

  it("decrypts the address once per message and keeps none of it", async () => {
    const { service, decrypt } = build();

    await service.sendConfirmation(BOOKING);
    await service.sendCancellation({
      ...BOOKING,
      cancelledByPersonId: BOARD_MEMBER,
    });

    // Two messages, two decryptions. One would mean the plaintext survived the
    // first send somewhere on this service.
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(decrypt).toHaveBeenCalledWith("person.email", "cipher-for-rune");
  });

  it("sends nothing to a resident with no address on file", async () => {
    const { service, send } = build({
      firstName: "Rune",
      lastName: "Boende",
      emailCipher: null,
      preferredLocale: "sv",
    });

    await expect(service.sendConfirmation(BOOKING)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing when the booker's row has been purged", async () => {
    const { service, send } = build(null);

    await expect(service.sendConfirmation(BOOKING)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
