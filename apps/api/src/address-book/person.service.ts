import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { isValidPersonalIdentityNumber } from "../crypto/personal-data";
import { PrismaService } from "../database/prisma.service";
import type {
  BoardPositionType,
  ResidencyRole,
  SystemRoleType,
} from "../generated/prisma/enums";
import { computePurgeDate } from "../retention/purge-date";
import { retentionDaysAfterMoveOut } from "../retention/retention-policy";
import {
  type AddressBookContact,
  hasMovedOut,
  isMasked,
  type MaskableField,
  toIsoDate,
} from "./address-book-view";
import {
  consentStateFor,
  type PublicationConsentView,
} from "./publication-consent";

export class PersonError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "person-not-found"
      | "invalid-personal-identity-number"
      | "invalid-email"
      | "field-not-masked",
  ) {
    super(message);
    this.name = "PersonError";
  }
}

/**
 * The postal address, masked for a person with protected personal data.
 *
 * The postal address is the field protection exists to withhold: a person with
 * skyddade personuppgifter is protected precisely because their whereabouts must
 * not be discoverable. The alternative address, when the cooperative has one on
 * file, is what may be shown in its place.
 */
export type MaskedPostalAddress =
  | {
      state: "visible";
      street: string | null;
      postalCode: string | null;
      city: string | null;
    }
  | { state: "masked"; alternativePostalAddress: string | null };

export interface PersonResidencyView {
  residencyId: string;
  apartmentId: string;
  apartmentNumber: string;
  addressId: string;
  addressLabel: string;
  role: ResidencyRole;
  movedInOn: string | null;
  movedOutOn: string | null;
  /** Derived from the retention policy, null while the residency is current. */
  purgeOn: string | null;
}

export interface PersonBoardPositionView {
  position: BoardPositionType;
  electedOn: string | null;
  endedOn: string | null;
}

export interface PersonAccountView {
  state: "active" | "invited" | "none";
  twoFactorEnabled: boolean;
  invitationExpiresAt: string | null;
}

export interface PersonDetail {
  personId: string;
  firstName: string;
  lastName: string;
  postalAddress: MaskedPostalAddress;
  contact: AddressBookContact;
  /**
   * Whether a personal identity number is on file. Never the value: that is
   * reachable only through the audited reveal, and never appears in a list or a
   * detail payload (DESIGN.md).
   */
  hasPersonalIdentityNumber: boolean;
  protectedPersonalData: boolean;
  preferredLocale: string;
  /** Derived: holds at least one current tenant-ownership. */
  isMember: boolean;
  residencies: PersonResidencyView[];
  boardPositions: PersonBoardPositionView[];
  systemRoles: SystemRoleType[];
  account: PersonAccountView;
  /**
   * Publication consent per scope (publiceringssamtycke).
   *
   * On this payload and no other. The resident-facing directory has no person
   * view at all, so a resident never sees this - which is the point: it is what
   * the board recorded about a person, and a person reading their own entry
   * would be reading the board's note rather than giving consent.
   */
  publicationConsents: PublicationConsentView[];
}

export interface CreatePersonInput {
  firstName: string;
  lastName: string;
  postalStreet?: string;
  postalCode?: string;
  postalCity?: string;
  alternativePostalAddress?: string;
  email?: string;
  phone?: string;
  personalIdentityNumber?: string;
  protectedPersonalData?: boolean;
  preferredLocale?: string;
}

/** What a reveal returns: only the fields that were asked for and audited. */
export interface RevealedFields {
  email?: string | null;
  phone?: string | null;
  personalIdentityNumber?: string | null;
  postalAddress?: {
    street: string | null;
    postalCode: string | null;
    city: string | null;
  } | null;
}

/**
 * The person view of the address book, and the audited reveal.
 *
 * Everything here that touches a masked field goes through
 * {@link PersonService.reveal}, which writes its audit entry in the same
 * transaction as the read. That is not a convention: an access to protected
 * personal data and the record of that access have to commit or roll back
 * together, or the log either misses accesses that happened or claims ones that
 * did not.
 */
@Injectable()
export class PersonService {
  private readonly logger = new Logger(PersonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * One person as the board sees them.
   *
   * Masked fields come back as a masked marker, never as a value the caller
   * might forget to hide. Nothing here is audited, because nothing here reveals
   * anything: reading that a protected person has a phone number on file is not
   * reading the number.
   */
  async detail(
    personId: string,
    now: Date = new Date(),
  ): Promise<PersonDetail> {
    const retentionDays = await retentionDaysAfterMoveOut(this.prisma);

    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        postalStreet: true,
        postalCode: true,
        postalCity: true,
        alternativePostalAddress: true,
        emailCipher: true,
        phoneCipher: true,
        personalIdentityNumberCipher: true,
        protectedPersonalData: true,
        preferredLocale: true,
        systemRoles: { select: { role: true } },
        boardPositions: {
          orderBy: [{ electedOn: "desc" }],
          select: { position: true, electedOn: true, endedOn: true },
        },
        residencies: {
          orderBy: [{ movedInOn: "desc" }],
          select: {
            id: true,
            role: true,
            movedInOn: true,
            movedOutOn: true,
            apartment: {
              select: {
                id: true,
                number: true,
                address: {
                  select: { id: true, street: true, number: true },
                },
              },
            },
          },
        },
        userAccount: { select: { id: true, twoFactorEnabled: true } },
        invitations: {
          where: { acceptedAt: null },
          orderBy: [{ createdAt: "desc" }],
          take: 1,
          select: { expiresAt: true },
        },
        publicationConsents: {
          orderBy: [{ grantedAt: "desc" }],
          select: {
            scope: true,
            grantedAt: true,
            withdrawnAt: true,
            note: true,
          },
        },
      },
    });

    if (person === null) {
      throw new PersonError("No such person.", "person-not-found");
    }

    const protectedData = person.protectedPersonalData;

    const contact: AddressBookContact = protectedData
      ? {
          state: "masked",
          hasEmail: person.emailCipher != null,
          hasPhone: person.phoneCipher != null,
        }
      : {
          state: "visible",
          email:
            person.emailCipher == null
              ? null
              : await this.encryption.decrypt(
                  "person.email",
                  person.emailCipher,
                ),
          phone:
            person.phoneCipher == null
              ? null
              : await this.encryption.decrypt(
                  "person.phone",
                  person.phoneCipher,
                ),
        };

    const pendingInvitation = person.invitations[0];

    return {
      personId: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      postalAddress: isMasked("postalAddress", person)
        ? {
            state: "masked",
            alternativePostalAddress: person.alternativePostalAddress,
          }
        : {
            state: "visible",
            street: person.postalStreet,
            postalCode: person.postalCode,
            city: person.postalCity,
          },
      contact,
      hasPersonalIdentityNumber: person.personalIdentityNumberCipher != null,
      protectedPersonalData: protectedData,
      preferredLocale: person.preferredLocale,
      isMember: person.residencies.some(
        (residency) =>
          residency.role === "MEMBER" &&
          !hasMovedOut(residency.movedOutOn, now),
      ),
      residencies: person.residencies.map((residency) => ({
        residencyId: residency.id,
        apartmentId: residency.apartment.id,
        apartmentNumber: residency.apartment.number,
        addressId: residency.apartment.address.id,
        addressLabel: `${residency.apartment.address.street} ${residency.apartment.address.number}`,
        role: residency.role,
        movedInOn: toIsoDate(residency.movedInOn),
        movedOutOn: toIsoDate(residency.movedOutOn),
        purgeOn: toIsoDate(
          computePurgeDate(residency.movedOutOn, retentionDays),
        ),
      })),
      boardPositions: person.boardPositions.map((position) => ({
        position: position.position,
        electedOn: toIsoDate(position.electedOn),
        endedOn: toIsoDate(position.endedOn),
      })),
      systemRoles: person.systemRoles.map((role) => role.role),
      account: {
        state:
          person.userAccount !== null
            ? "active"
            : pendingInvitation === undefined
              ? "none"
              : "invited",
        twoFactorEnabled: person.userAccount?.twoFactorEnabled === true,
        invitationExpiresAt:
          pendingInvitation === undefined
            ? null
            : pendingInvitation.expiresAt.toISOString(),
      },
      publicationConsents: consentStateFor(person.publicationConsents),
    };
  }

  /**
   * Reveals masked fields, writing the audit entry in the same transaction.
   *
   * Only fields that are actually masked can be revealed. Asking to "reveal" an
   * unmasked email is refused rather than quietly logged, because an audit log
   * full of reveals of data the board could already see is an audit log nobody
   * reads - and the log is the evidence a data protection authority would ask
   * for.
   *
   * A personal identity number is always masked, protected flag or not, so a
   * reveal is the only way to see one and every one of them lands in the log.
   */
  async reveal(input: {
    actorPersonId: string;
    personId: string;
    fields: readonly MaskableField[];
    reason?: string;
  }): Promise<RevealedFields> {
    const person = await this.prisma.person.findUnique({
      where: { id: input.personId },
      select: { id: true, protectedPersonalData: true },
    });
    if (person === null) {
      throw new PersonError("No such person.", "person-not-found");
    }

    const notMasked = input.fields.filter((field) => !isMasked(field, person));
    if (notMasked.length > 0) {
      throw new PersonError(
        `These fields are not masked for this person: ${notMasked.join(", ")}.`,
        "field-not-masked",
      );
    }

    const revealed = await this.audit.withAuditedRead<RevealedFields>(
      {
        action: "PROTECTED_DATA_REVEALED",
        actorPersonId: input.actorPersonId,
        targetPersonId: input.personId,
        context: {
          fields: [...input.fields],
          // The log distinguishes the two reasons a field was masked, because
          // they answer different questions: whether a protected person's data
          // was accessed, and who has seen a personal identity number.
          protectedPersonalData: person.protectedPersonalData,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      },
      async (tx) => {
        const row = await tx.person.findUniqueOrThrow({
          where: { id: input.personId },
          select: {
            emailCipher: true,
            phoneCipher: true,
            personalIdentityNumberCipher: true,
            postalStreet: true,
            postalCode: true,
            postalCity: true,
          },
        });

        const result: RevealedFields = {};
        for (const field of input.fields) {
          switch (field) {
            case "email":
              result.email =
                row.emailCipher == null
                  ? null
                  : await this.encryption.decrypt(
                      "person.email",
                      row.emailCipher,
                    );
              break;
            case "phone":
              result.phone =
                row.phoneCipher == null
                  ? null
                  : await this.encryption.decrypt(
                      "person.phone",
                      row.phoneCipher,
                    );
              break;
            case "personalIdentityNumber":
              result.personalIdentityNumber =
                row.personalIdentityNumberCipher == null
                  ? null
                  : await this.encryption.decrypt(
                      "person.personalIdentityNumber",
                      row.personalIdentityNumberCipher,
                    );
              break;
            case "postalAddress":
              result.postalAddress = {
                street: row.postalStreet,
                postalCode: row.postalCode,
                city: row.postalCity,
              };
              break;
          }
        }
        return result;
      },
    );

    // The fields, never the values: a log line is not a place for personal data.
    this.logger.log(
      `Revealed ${input.fields.join(", ")} on person ${input.personId}`,
    );
    return revealed;
  }

  /**
   * Adds a person to the register.
   *
   * Creates the person record only. Placing someone in an apartment is the
   * move-in flow, which also writes the statutory member register entry when the
   * person takes over a tenant-ownership; doing half of that here would leave
   * the member register (EFL 5 kap.) disagreeing with the residency table, in
   * the one table that cannot be corrected by editing.
   *
   * This is what an invitation needs: a person with a name and an email, with or
   * without an apartment. External board members and admins never have one.
   */
  async create(
    input: CreatePersonInput,
    actorPersonId: string,
  ): Promise<{ personId: string }> {
    const email =
      input.email === undefined || input.email.trim() === ""
        ? null
        : await this.encryption.encrypt("person.email", input.email);
    if (email !== null && email.index === null) {
      // Without an index the address could never be searched or matched, so it
      // would be stored unreachable rather than stored badly.
      throw new PersonError(
        "That email address could not be read.",
        "invalid-email",
      );
    }

    const phone =
      input.phone === undefined || input.phone.trim() === ""
        ? null
        : await this.encryption.encrypt("person.phone", input.phone);

    let identityNumber = null;
    if (
      input.personalIdentityNumber !== undefined &&
      input.personalIdentityNumber.trim() !== ""
    ) {
      if (!isValidPersonalIdentityNumber(input.personalIdentityNumber)) {
        // Checked rather than stored: a personal identity number that fails its
        // own checksum is a typing mistake, and it would sit in the apartment
        // register as a fact about a person who does not exist.
        throw new PersonError(
          "That personal identity number is not valid.",
          "invalid-personal-identity-number",
        );
      }
      identityNumber = await this.encryption.encrypt(
        "person.personalIdentityNumber",
        input.personalIdentityNumber,
      );
    }

    const protectedData = input.protectedPersonalData ?? false;

    const person = await this.prisma.$transaction(async (tx) => {
      const created = await tx.person.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          postalStreet: input.postalStreet ?? null,
          postalCode: input.postalCode ?? null,
          postalCity: input.postalCity ?? null,
          alternativePostalAddress: input.alternativePostalAddress ?? null,
          emailCipher: email?.cipher ?? null,
          emailIndex: email?.index ?? null,
          phoneCipher: phone?.cipher ?? null,
          phoneIndex: phone?.index ?? null,
          personalIdentityNumberCipher: identityNumber?.cipher ?? null,
          personalIdentityNumberIndex: identityNumber?.index ?? null,
          protectedPersonalData: protectedData,
          preferredLocale: input.preferredLocale ?? "sv",
        },
        select: { id: true },
      });

      if (protectedData) {
        // Entering someone as protected is a flag change from the default, and
        // the flag's history has to be complete to be worth anything.
        await this.audit.record(
          {
            action: "PROTECTED_FLAG_CHANGED",
            actorPersonId,
            targetPersonId: created.id,
            context: { protectedPersonalData: true, atCreation: true },
          },
          tx,
        );
      }

      return created;
    });

    this.logger.log(`Added person ${person.id} to the register`);
    return { personId: person.id };
  }

  /**
   * Sets or clears the protected personal data flag.
   *
   * Audited in both directions and in the same transaction as the change.
   * Clearing it is the more dangerous direction - it unmasks a person
   * everywhere - so it is the one the log most needs to carry.
   */
  async setProtectedPersonalData(input: {
    personId: string;
    protectedPersonalData: boolean;
    actorPersonId: string;
    reason?: string;
  }): Promise<{ protectedPersonalData: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const person = await tx.person.findUnique({
        where: { id: input.personId },
        select: { protectedPersonalData: true },
      });
      if (person === null) {
        throw new PersonError("No such person.", "person-not-found");
      }

      if (person.protectedPersonalData === input.protectedPersonalData) {
        // Nothing changed, so there is nothing to log. Recording a no-op would
        // pad the log with entries that never correspond to an act.
        return { protectedPersonalData: person.protectedPersonalData };
      }

      await tx.person.update({
        where: { id: input.personId },
        data: { protectedPersonalData: input.protectedPersonalData },
      });

      await this.audit.record(
        {
          action: "PROTECTED_FLAG_CHANGED",
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          context: {
            protectedPersonalData: input.protectedPersonalData,
            previous: person.protectedPersonalData,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        },
        tx,
      );

      return { protectedPersonalData: input.protectedPersonalData };
    });
  }
}
