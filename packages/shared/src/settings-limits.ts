/**
 * How long the facts the settings screens and the first-boot setup record may
 * be.
 *
 * Here rather than beside the schemas that enforce them, for the reason
 * `ISSUE_REPORT_LIMITS` gives: each form has to know the same numbers, and a
 * value the field accepted and the server refuses is refused with no word on
 * which length was wrong.
 */

/** The association itself, by the name its statutory documents carry. */
export const HOUSING_COOPERATIVE_LIMITS = {
  name: 200,
} as const;

/** Where the association is paid. */
export const FINANCE_LIMITS = {
  bankgiro: 20,
  plusgiro: 20,
} as const;

/** The gateway text messages go out through. */
export const SMS_LIMITS = {
  driver: 64,
  senderName: 64,
} as const;

/** An address and the apartments behind it. */
export const ADDRESS_LIMITS = {
  street: 200,
  number: 20,
  city: 100,
  /** Free text, because an older cooperative may number them 1, 2, 3. */
  apartmentNumber: 20,
} as const;

/** A laundry room, a guest apartment or anything else the board lets out. */
export const BOOKABLE_RESOURCE_LIMITS = {
  name: 100,
  description: 1000,
} as const;

/** A kind of issue report the board sorts reports into. */
export const ISSUE_TYPE_LIMITS = {
  name: 100,
} as const;

/** The first administrator, created by the setup. */
export const ADMINISTRATOR_LIMITS = {
  firstName: 100,
  lastName: 100,
  email: 320,
  claimToken: 200,
} as const;

/** The shortest password an account may have, set on the sign-in library. */
export const MIN_PASSWORD_LENGTH = 12;

/** The longest, which the sign-in library refuses past on every account. */
export const MAX_PASSWORD_LENGTH = 128;
