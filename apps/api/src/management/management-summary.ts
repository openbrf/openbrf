/**
 * The document the management API answers with (ADR 0021).
 *
 * What whoever hosts the instance needs to bill it, to run its trial, to watch
 * for abuse and to upgrade it, and nothing about any one person: counts, one
 * calendar day, and the version. No identifier, name, date of birth, apartment
 * number or per-person row is in it, and none may be added. The only fact in
 * time is `boardActivityOn`, a day on the association's calendar (ADR 0013) -
 * not a timestamp, and not whose.
 *
 * `schema` is 1. A field added keeps 1. A field removed, or one whose meaning
 * changes, is a new document at `/v2/summary`, with `/v1` answered until the
 * control plane has moved: the rule ADR 0008 set for action names.
 *
 * docs/management-api.md is this type for a reader outside the repository, a
 * field at a time, and says where each one is read from.
 */
export interface ManagementSummary {
  readonly schema: 1;
  /** The platform's version: the fixed group's, from apps/api/package.json. */
  readonly version: string;
  /** The commit the image was built from, or null outside an image. */
  readonly revision: string | null;
  readonly migrations: {
    /** Migrations in this image's prisma/migrations, listed once at start. */
    readonly shipped: number;
    /** Rows in _prisma_migrations that finished and were not rolled back. */
    readonly applied: number;
    /** Rows that neither finished nor were rolled back: a failed start. */
    readonly failed: number;
    /** Shipped migrations with no applied row. */
    readonly pending: number;
    /** The newest applied migration's name, or null when none is. */
    readonly latest: string | null;
  };
  /** Whether setup has been completed. */
  readonly claimed: boolean;
  /**
   * Every apartment row, which is the billing basis. An apartment is deleted
   * rather than retired, so the rows are the apartments there are.
   */
  readonly apartments: number;
  readonly register: {
    /** Every person in the register. */
    readonly persons: number;
    /** Persons holding a MEMBER residency today. */
    readonly members: number;
    /** Persons holding any residency today. */
    readonly residents: number;
    /** Board seats held today. */
    readonly boardSeats: number;
    /** Persons holding the ADMIN system role. */
    readonly administrators: number;
  };
  /**
   * Persons who hold a residency today, hold no board seat today and no system
   * role, and have an account or an invitation neither accepted nor expired.
   * Counted from accounts rather than from invitation rows, because an
   * accepted invitation does not outlive its account and an unaccepted one is
   * replaced on every re-invite.
   */
  readonly invitedResidents: number;
  /**
   * The latest day, "YYYY-MM-DD" on the association's calendar, on which a
   * person holding a board seat or ADMIN today renewed a session or acted
   * through the web interface, a connected app, the AI package or a plugin -
   * or through no recorded channel. Null when there is none. Neither the
   * system's own jobs nor the management API's reads count.
   */
  readonly boardActivityOn: string | null;
  /**
   * How many times each register extract was generated, through the same
   * channels as board activity. Generated, not printed: printing is the
   * browser's, and the entry is written each time the extract is served.
   */
  readonly registerExtracts: {
    readonly memberRegister: number;
    readonly apartmentRegister: number;
  };
  readonly storage: {
    /**
     * Every stored file's size as uploaded. The ciphertext on the volume is a
     * little larger, and plugins and themes are not counted.
     */
    readonly storedFileBytes: number;
    /** The database's own size. */
    readonly databaseBytes: number;
  };
  readonly health: {
    /** The document was read in a transaction that committed. */
    readonly database: "ok";
    /** How many findings the plugins screen shows: plugins refused or dropped. */
    readonly pluginFindings: number;
  };
}

/** The document's version, which is also its audit entry's context. */
export const MANAGEMENT_SUMMARY_SCHEMA = 1;
