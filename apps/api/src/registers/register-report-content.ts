import {
  formatDateColumn,
  normalizePersonalIdentityNumber,
} from "@openbrf/shared";
import { z } from "zod";

import type {
  RegisterReportKind,
  TransferReportBasis,
} from "../generated/prisma/client";
import {
  TerminationKind,
  TransferReversalKind,
} from "../generated/prisma/enums";

/**
 * What one report to the cooperative housing register says.
 *
 * The platform's side of the port in ADR 0029. The content is the statute's -
 * Lag (2026:484) 3 kap. names the events, and Förordning (2026:898) 2 kap. the
 * fields the register holds about them - and the shape is Open BRF's own,
 * because the föreskrifter that would fix one (Förordning (2026:898) 2 kap. 2 §
 * and 5 kap. 1-2 §§) have not been issued. An adapter maps from this schema to
 * whatever Lantmäteriet publishes; it does not reshape it.
 *
 * A pure module, so what a report carries is tested without a database: the
 * service reads the rows and decrypts the one number, and everything that
 * decides what goes out is here.
 *
 * ## Carried, and deliberately not
 *
 * The association by name and organisationsnummer, the apartment by its
 * Lantmäteriet number and address, the event's own dates and case, and at most
 * one person. Not the seller of a transfer, whom the register already holds as
 * the holder the transfer ends; not the price; not the deadline, which is the
 * association's business rather than the register's.
 */

/** A calendar day, as the report states every date. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const postalAddressSchema = z.object({
  street: z.string().min(1),
  postalCode: z.string().min(1),
  city: z.string().min(1),
});

/**
 * A natural person the report names.
 *
 * The postal address is null for a person with skyddade personuppgifter, and
 * the flag beside it says that is why: the initial supply's reasoning, unchanged.
 * Lantmäteriet holds their address through Skatteverket, where the protection is
 * administered. It is null too where the register holds no address, and the
 * flag is then false.
 */
const personSchema = z
  .object({
    kind: z.literal("PERSON"),
    name: z.string().min(1),
    /** Twelve digits, YYYYMMDDNNNN. */
    personalIdentityNumber: z.string().regex(/^\d{12}$/),
    postalAddress: postalAddressSchema.nullable(),
    protectedPersonalData: z.boolean(),
  })
  .refine(
    (person) => !person.protectedPersonalData || person.postalAddress === null,
    { message: "a protected person's address is withheld" },
  );

/** The association itself as the acquirer: 3 kap. 3 § fjärde stycket. */
const associationAcquirerSchema = z.object({ kind: z.literal("ASSOCIATION") });

export const registerReportSchema = z.object({
  /**
   * The platform's own reference for the report: the obligation's id.
   *
   * What an adapter sends as the idempotency key where the interface has one,
   * so a resend after an unknown outcome is the same report and not a second.
   */
  reference: z.string().min(1),
  association: z.object({
    name: z.string().min(1),
    organizationNumber: z.string().min(1),
  }),
  apartment: z.object({
    /** Lantmäteriet's numbering, e.g. 1101. */
    number: z.string().min(1),
    street: z.string().min(1),
    streetNumber: z.string().min(1),
    postalCode: z.string(),
    city: z.string(),
  }),
  event: z.discriminatedUnion("kind", [
    /** 3 kap. 2 §: an upplåtelse, reported from its own day. */
    z.object({
      kind: z.literal("GRANT"),
      grantedOn: daySchema,
      holder: personSchema,
    }),
    /**
     * 3 kap. 3 §: an övergång. Which of the section's cases it is travels with
     * it, because the case is what dates the window and the register has no
     * other way to know which day the association counted from.
     */
    z
      .object({
        kind: z.literal("TRANSFER"),
        transferredOn: daySchema,
        reportBasis: z.enum([
          "MEMBERSHIP_DECISION",
          "ALREADY_MEMBER",
          "OUTSIDE_MEMBERSHIP_REQUIREMENT",
          "TO_THE_ASSOCIATION",
        ]),
        membershipDecidedOn: daySchema.nullable(),
        acquirer: z.union([personSchema, associationAcquirerSchema]),
      })
      .refine(
        (event) =>
          (event.reportBasis === "MEMBERSHIP_DECISION") ===
          (event.membershipDecidedOn !== null),
        { message: "a membership decision date belongs to that case alone" },
      )
      .refine(
        (event) =>
          (event.reportBasis === "TO_THE_ASSOCIATION") ===
          (event.acquirer.kind === "ASSOCIATION"),
        { message: "the association is the acquirer in that case alone" },
      ),
    /** 3 kap. 4 §: a bostadsrätt that has ceased. It names no person. */
    z.object({
      kind: z.literal("TERMINATION"),
      tookEffectOn: daySchema,
      ground: z.enum(TerminationKind),
    }),
    /**
     * 3 kap. 3 § tredje stycket: a registered överlåtelse hävd or gone back to
     * the seller. Identified by the day of the övergång it undid, which the
     * register already holds.
     */
    z.object({
      kind: z.literal("TRANSFER_REVERSAL"),
      reversedOn: daySchema,
      ground: z.enum(TransferReversalKind),
      transferredOn: daySchema,
    }),
  ]),
});

export type RegisterReport = z.infer<typeof registerReportSchema>;

/** A person row as the service hands it over, with the one number decrypted. */
export interface ReportSourcePerson {
  id: string;
  firstName: string;
  lastName: string;
  postalStreet: string | null;
  postalCode: string | null;
  postalCity: string | null;
  protectedPersonalData: boolean;
  /** Decrypted, in whatever form it was stored; null where none is held. */
  personalIdentityNumber: string | null;
}

/** One ledger row and every register row the report is rendered from. */
export interface ReportSource {
  obligationId: string;
  kind: RegisterReportKind;
  association: { name: string; organizationNumber: string | null } | null;
  apartment: {
    number: string;
    address: {
      street: string;
      number: string;
      postalCode: string;
      city: string;
    };
  };
  transfer: {
    transferredOn: Date;
    reportBasis: TransferReportBasis | null;
    membershipDecidedOn: Date | null;
    toPerson: ReportSourcePerson;
  } | null;
  termination: { tookEffectOn: Date; kind: TerminationKind } | null;
  reversal: {
    reversedOn: Date;
    kind: TransferReversalKind;
    transferredOn: Date;
  } | null;
}

/** Why a report cannot be complete, and so is not sent. */
export type ReportProblem =
  | "association-not-set-up"
  | "association-organization-number-missing"
  | "holder-identity-number-missing"
  | "holder-identity-number-invalid"
  | "transfer-case-not-stated";

export type RenderedReport =
  | {
      ok: true;
      report: RegisterReport;
      /** Every person whose personal identity number the report carries. */
      personIds: string[];
      /** Those of them with skyddade personuppgifter. */
      protectedPersonIds: string[];
    }
  | { ok: false; problem: ReportProblem };

/**
 * Renders the report for one duty, or says why it cannot be complete.
 *
 * Refused rather than sent short. Lag (2026:484) 3 kap. 2 and 3 §§ make a
 * registration take effect when "en fullständig anmälan" reaches Lantmäteriet,
 * so a report missing what identifies the association or the holder does not
 * discharge the duty; it only moves the failure somewhere the board cannot see
 * it.
 *
 * @param referenceDate The day a personal identity number stored without its
 *   century is read against, which is the reading every other part of the
 *   product takes of a stored number.
 */
export function renderRegisterReport(
  source: ReportSource,
  referenceDate: Date,
): RenderedReport {
  if (source.association === null) {
    return { ok: false, problem: "association-not-set-up" };
  }
  const organizationNumber = (
    source.association.organizationNumber ?? ""
  ).trim();
  if (organizationNumber === "") {
    return { ok: false, problem: "association-organization-number-missing" };
  }

  const head = {
    reference: source.obligationId,
    association: {
      name: source.association.name.trim(),
      organizationNumber,
    },
    apartment: {
      number: source.apartment.number,
      street: source.apartment.address.street,
      streetNumber: source.apartment.address.number,
      postalCode: source.apartment.address.postalCode,
      city: source.apartment.address.city,
    },
  };

  const personIds: string[] = [];
  const protectedPersonIds: string[] = [];
  const person = (
    row: ReportSourcePerson,
  ):
    | { ok: true; value: z.infer<typeof personSchema> }
    | { ok: false; problem: ReportProblem } => {
    if (row.personalIdentityNumber === null) {
      return { ok: false, problem: "holder-identity-number-missing" };
    }
    const normalized = normalizePersonalIdentityNumber(
      row.personalIdentityNumber,
      referenceDate,
    );
    if (normalized === null) {
      return { ok: false, problem: "holder-identity-number-invalid" };
    }
    personIds.push(row.id);
    if (row.protectedPersonalData) {
      protectedPersonIds.push(row.id);
    }
    const street = (row.postalStreet ?? "").trim();
    const postalCode = (row.postalCode ?? "").trim();
    const city = (row.postalCity ?? "").trim();
    return {
      ok: true,
      value: {
        kind: "PERSON",
        name: `${row.firstName} ${row.lastName}`.trim(),
        personalIdentityNumber: normalized,
        // Withheld for a protected person, and null rather than partial where
        // any line is missing: half an address is not one Lantmäteriet can use.
        postalAddress:
          row.protectedPersonalData ||
          street === "" ||
          postalCode === "" ||
          city === ""
            ? null
            : { street, postalCode, city },
        protectedPersonalData: row.protectedPersonalData,
      },
    };
  };

  const done = (event: RegisterReport["event"]): RenderedReport => ({
    ok: true,
    report: { ...head, event },
    personIds,
    protectedPersonIds,
  });

  switch (source.kind) {
    case "GRANT": {
      const transfer = required(source.transfer, source);
      const holder = person(transfer.toPerson);
      if (!holder.ok) {
        return holder;
      }
      return done({
        kind: "GRANT",
        grantedOn: day(transfer.transferredOn),
        holder: holder.value,
      });
    }
    case "TRANSFER": {
      const transfer = required(source.transfer, source);
      const basis = transferCase(transfer);
      if (basis === null) {
        return { ok: false, problem: "transfer-case-not-stated" };
      }
      if (basis === "TO_THE_ASSOCIATION") {
        return done({
          kind: "TRANSFER",
          transferredOn: day(transfer.transferredOn),
          reportBasis: basis,
          membershipDecidedOn: null,
          acquirer: { kind: "ASSOCIATION" },
        });
      }
      const acquirer = person(transfer.toPerson);
      if (!acquirer.ok) {
        return acquirer;
      }
      return done({
        kind: "TRANSFER",
        transferredOn: day(transfer.transferredOn),
        reportBasis: basis,
        membershipDecidedOn:
          basis === "MEMBERSHIP_DECISION"
            ? day(transfer.membershipDecidedOn)
            : null,
        acquirer: acquirer.value,
      });
    }
    case "TERMINATION": {
      const termination = required(source.termination, source);
      return done({
        kind: "TERMINATION",
        tookEffectOn: day(termination.tookEffectOn),
        ground: termination.kind,
      });
    }
    case "TRANSFER_REVERSAL": {
      const reversal = required(source.reversal, source);
      return done({
        kind: "TRANSFER_REVERSAL",
        reversedOn: day(reversal.reversedOn),
        ground: reversal.kind,
        transferredOn: day(reversal.transferredOn),
      });
    }
  }
}

/**
 * Which case of 3 kap. 3 § the report states, or null where none can be.
 *
 * A transfer whose membership decision was recorded before the board was asked
 * which case applied carries no basis, and its duty was entered on the first
 * case's day. `ApartmentRegisterService.recordReportBasis` refuses to state one
 * afterwards for exactly that reason - "its duty is already in the ledger, on
 * the right paragraph and the right day" - so the report states that case too
 * rather than leaving the duty with no way to be sent. That reading is the
 * ledger's, not a guess made here: the decision date is what opened the window.
 *
 * A juridical person's case never has a duty (första stycket makes the anmälan
 * theirs, and the ledger's trigger refuses one), so it is not a case a report
 * can state.
 */
function transferCase(
  transfer: NonNullable<ReportSource["transfer"]>,
): Exclude<TransferReportBasis, "LIENHOLDING_JURIDICAL_PERSON"> | null {
  switch (transfer.reportBasis) {
    case null:
      return transfer.membershipDecidedOn === null
        ? null
        : "MEMBERSHIP_DECISION";
    case "MEMBERSHIP_DECISION":
      return transfer.membershipDecidedOn === null
        ? null
        : "MEMBERSHIP_DECISION";
    case "LIENHOLDING_JURIDICAL_PERSON":
      return null;
    default:
      return transfer.reportBasis;
  }
}

/**
 * The register event the ledger row points at.
 *
 * Thrown rather than reported as a problem: the ledger's CHECK requires exactly
 * the reference that matches the row's kind, so a missing one is a broken
 * invariant and not something a board can fix.
 */
function required<T>(value: T | null, source: ReportSource): T {
  if (value === null) {
    throw new Error(
      `Reporting obligation ${source.obligationId} of kind ${source.kind} has no event to report.`,
    );
  }
  return value;
}

function day(value: Date | null): string {
  return formatDateColumn(value) ?? "";
}
