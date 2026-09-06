/**
 * The vocabulary the association's own data protection records are written in:
 * which categories of personal data a processing touches, and whose data it is.
 *
 * GDPR art. 30(1)(c) has the record of processing activities
 * (registerförteckning) state "the categories of data subjects and the
 * categories of personal data", and art. 33(3)(a) has a personal data breach
 * (personuppgiftsincident) state the same two things about what it reached.
 * Both records answer the same question, so both read from one list here
 * rather than from an enum of their own: a category renamed in one place would
 * otherwise leave two records describing the same processing differently.
 *
 * They are string lists rather than database enums because they are a
 * vocabulary the board reads and the browser renders, not a state machine. The
 * columns that hold them are String[], and a value is validated against the
 * list at the controller.
 *
 * The first five personal data categories are spelled exactly as
 * PLUGIN_PERSONAL_DATA_CATEGORIES in packages/plugin-sdk/src/permissions.ts,
 * so an installed plugin's declaration becomes a processing activity's
 * categories with no mapping between the two. That equality is asserted by a
 * test on the API side, which is the only place that can import both packages:
 * this package and the plugin SDK do not depend on each other, deliberately,
 * because the SDK is published to plugin authors.
 *
 * Swedish domain terms follow GLOSSARY.md.
 */

/**
 * What a processing touches, or what a breach reached (art. 30(1)(c),
 * art. 33(3)(a)).
 *
 * Ordered from what every processing holds towards what few do, so the
 * checkboxes a board ticks read top to bottom in the order it thinks in.
 */
export const PERSONAL_DATA_CATEGORIES = [
  /** Given and family name. */
  "name",
  /** Which apartment and address a person is connected to. */
  "apartment",
  /** Move-in and move-out dates, and whether the person is a member. */
  "residency",
  "email",
  "phone",
  /** A postal address of the person's own, not the apartment's. */
  "postalAddress",
  /** Personal identity number (personnummer). */
  "personalIdentityNumber",
  /** Sign-in credentials and sessions. */
  "account",
  /** Charges, debiting basis and what a person owes or has paid. */
  "financial",
  /**
   * Health, an art. 9 special category. No screen asks for it; it is here
   * because a person writing an issue report may volunteer it, and a record
   * that could not say so would be describing the processing inaccurately.
   */
  "health",
  /** A photograph, whether or not anybody is recognisable in it. */
  "photograph",
  /** Text a person wrote themselves, which may name anybody. */
  "freeText",
  /** The audit log's record of who did what to whose data. */
  "auditTrail",
] as const;

export type PersonalDataCategory = (typeof PERSONAL_DATA_CATEGORIES)[number];

/**
 * Whose data a processing is about (art. 30(1)(c), art. 33(3)(a)).
 *
 * A person is in more than one category over time and often at once: a board
 * member lives in the building, and a member who moves out stays in the member
 * register. The categories describe the processing, not the person.
 */
export const DATA_SUBJECT_CATEGORIES = [
  /** A member of the association (medlem). */
  "member",
  /** Somebody living in the building without being a member. */
  "resident",
  /** Somebody whose residency has ended. */
  "formerResident",
  /** Somebody holding a position of trust (förtroendepost). */
  "boardMember",
  /** Somebody who has asked for an account and has not been decided on. */
  "applicant",
  /**
   * Somebody outside the association entirely: a contractor, a broker, an
   * external property manager, or whoever wrote through the contact form.
   */
  "external",
] as const;

export type DataSubjectCategory = (typeof DATA_SUBJECT_CATEGORIES)[number];
