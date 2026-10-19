/**
 * The association's finances, as a plugin may read them, record a delivery
 * against them and hear about them.
 *
 * What is here is the free half of the boundary ROADMAP.md publishes: the
 * notices and charges core already records, read on the same masking rules as
 * the files the board hands over, a receipt that says one of them was
 * delivered, and an event that says one was issued. What carries them out of
 * Open BRF - an accounting system, a bankgiro file, a reminder - is the
 * plugin's own work.
 *
 * Three rules hold on every member here regardless of permission, and they are
 * the address book's (`PluginAddressBook`) read for money:
 *
 *   A person with protected personal data is never named. A notice for their
 *   household carries its apartment and its amount and withholds every name;
 *   a charge on them carries its date and its amount and withholds who, where
 *   and why. The row says so with a `withheld` branch rather than an empty
 *   string, so a reader cannot take a withheld value for an absent one.
 *
 *   A personal identity number is never returned. No row carries one.
 *
 *   There is no payment state, because core records none. Nothing here says
 *   whether a notice was paid, what is outstanding or what a balance is, and a
 *   delivery receipt is not that either: the accounting system settles the
 *   debt, and a second answer to whether something was paid is worse than none.
 */

/**
 * One delivery of a notice or a charge, as the plugin that made it recorded it.
 *
 * A receipt says that something left the association by a route, at a time,
 * under a reference the receiving system knows it by. It never says that the
 * money arrived, and it is not a status: a notice may carry several receipts,
 * from several plugins, and none of them changes the notice.
 */
export interface PluginDeliveryReceipt {
  id: string;
  /** The plugin that recorded it. */
  pluginId: string;
  /**
   * The route, in the recording plugin's own word for it: `fortnox`,
   * `autogiro`, `email`. Lowercase letters, digits and hyphens, at most 32.
   */
  channel: string;
  /**
   * What the receiving system calls it: a voucher number, a file name, a
   * message id. At most 128 characters.
   */
  reference: string;
  /** When it was delivered, as the plugin stated it. An ISO 8601 instant. */
  deliveredAt: string;
  /** When the receipt was recorded. An ISO 8601 instant. */
  recordedAt: string;
}

/** What a plugin states when it records a delivery. */
export interface PluginDeliveryReceiptInput {
  target:
    { kind: "feeNotice"; id: string } | { kind: "memberCharge"; id: string };
  channel: string;
  reference: string;
  /** When it was delivered. Now, when left out; never a time still to come. */
  deliveredAt?: Date;
}

/** Who a notice names, or the statement that the names are withheld. */
export type PluginFeeNoticeHolders =
  | {
      state: "visible";
      /** The tenant-owners' names, in the register's own order. */
      names: string[];
    }
  | { state: "withheld" };

/** One apartment's notice in one run (avi). */
export interface PluginFeeNotice {
  id: string;
  apartment: {
    id: string;
    /** "<street> <number> <apartment number>". Never withheld. */
    label: string;
    number: string;
  };
  /**
   * The tenant-owners holding the apartment when the period closed. Withheld
   * where anybody in the household carries protected personal data or has had
   * processing restricted (GDPR art. 18).
   */
  holders: PluginFeeNoticeHolders;
  /** Kronor with two decimals: "3450.50". What was billed, never a balance. */
  amount: string;
  paymentReference: string;
  deliveries: PluginDeliveryReceipt[];
}

/** A fee notification run (avisering) without its notices. */
export interface PluginFeeNotificationSummary {
  id: string;
  /** The period billed, inclusive at both ends. "YYYY-MM-DD". */
  from: string;
  to: string;
  /** The due date the board stated. Nothing in core computes from it. */
  dueOn: string;
  /** When the run was issued. An ISO 8601 instant. */
  issuedAt: string;
  /** How many notices the run carries. */
  notices: number;
  /** The sum of what was billed, as kronor with two decimals. */
  total: string;
}

/** A fee notification run with its notices. */
export interface PluginFeeNotification extends Omit<
  PluginFeeNotificationSummary,
  "notices"
> {
  notices: PluginFeeNotice[];
}

/** Who a charge is on, or the statement that it is withheld. */
export type PluginMemberChargeParty =
  | {
      kind: "person";
      state: "visible";
      personId: string;
      name: string;
      /**
       * Where they held a residency on the day of the charge, as the debiting
       * list prints it, or null where they held none.
       */
      apartment: string | null;
    }
  | {
      /**
       * A person the plugin is not told about: one carrying protected personal
       * data, one whose processing is restricted (GDPR art. 18), or one the
       * register no longer holds.
       */
      kind: "person";
      state: "withheld";
    }
  | {
      kind: "apartment";
      /** Null once the apartment has been corrected out of the register. */
      apartmentId: string | null;
      apartment: string | null;
    };

/** The board's own words for a charge, or the statement they are withheld. */
export type PluginMemberChargeReason =
  { state: "visible"; text: string } | { state: "withheld" };

/** One charge to a member or an apartment (debitering). */
export interface PluginMemberCharge {
  id: string;
  /** "YYYY-MM-DD" on the association's own calendar. */
  chargedOn: string;
  chargedTo: PluginMemberChargeParty;
  /** Kronor with two decimals. What was charged, never a balance. */
  amount: string;
  vatTreatment: "EXEMPT" | "RATE";
  /** Whole percent, and null exactly when the treatment is EXEMPT. */
  vatRatePercent: number | null;
  /**
   * Withheld with the party: what the board wrote about a protected person's
   * charge can say who they are as well as a name can.
   */
  reason: PluginMemberChargeReason;
  /** "YYYY-MM-DD" the basis went to the economic manager, or null. */
  handedToManagerOn: string | null;
  deliveries: PluginDeliveryReceipt[];
}

/**
 * The events the host delivers, by type, with the version it delivers.
 *
 * A version moves when a field is removed or changes meaning; a field added
 * keeps it. The host lists what it delivers in
 * `host.finances.events.supported`, so a plugin built against a newer SDK can
 * tell an event this instance will never send from one that has not happened.
 */
export const PLUGIN_FINANCE_EVENTS = {
  "feeNotification.issued": 1,
  "memberCharge.recorded": 1,
  "memberCharge.corrected": 1,
  "memberCharge.removed": 1,
} as const;

export type PluginFinanceEventType = keyof typeof PLUGIN_FINANCE_EVENTS;

interface PluginFinanceEventBase {
  /** Unique per event, and the same on every redelivery of it. */
  eventId: string;
  /** When the act was committed. An ISO 8601 instant. */
  occurredAt: string;
}

/**
 * Something happened to the association's finances.
 *
 * Identifiers only. An event carries nothing that names a person or states a
 * figure, so it needs no masking of its own: the plugin reads the row through
 * `host.finances`, on the same rules as every other read.
 */
export type PluginFinanceEvent =
  | (PluginFinanceEventBase & {
      type: "feeNotification.issued";
      version: 1;
      notificationId: string;
    })
  | (PluginFinanceEventBase & {
      type: "memberCharge.recorded" | "memberCharge.corrected";
      version: 1;
      chargeId: string;
    })
  | (PluginFinanceEventBase & {
      type: "memberCharge.removed";
      version: 1;
      /** The charge is gone; only its id is left to say which one it was. */
      chargeId: string;
    });

export interface PluginFinanceEvents {
  /** What this host delivers, by type and version. */
  readonly supported: Readonly<Record<string, number>>;
  /**
   * Receives every finance event from now on.
   *
   * Call it once, from `onModuleInit`. Delivery is at least once, from a queue
   * the host keeps for this plugin, and the event is enqueued in the same
   * transaction as the act it reports - so an act that rolled back never
   * produces one and one that committed always does. A handler that throws is
   * retried; one that keeps throwing has the event dropped once the retries
   * are spent. Order is not guaranteed. Ignore a `type` you do not know.
   *
   * Events reach a plugin that is serving and subscribed when the act
   * commits. A plugin switched off, or not yet subscribed, misses them, and
   * reads what it missed with `notifications()` and `charges()` when it starts.
   */
  subscribe(
    handler: (event: PluginFinanceEvent) => Promise<void> | void,
  ): Promise<void>;
}

/**
 * The association's finances, scoped to what the plugin declared.
 *
 * The reads and the events require finances:read; recording a delivery
 * requires finances:recordDelivery.
 */
export interface PluginFinances {
  /** The fee notification runs, newest period first. */
  notifications(): Promise<PluginFeeNotificationSummary[]>;
  /** One run with its notices, or null where there is no such run. */
  notification(id: string): Promise<PluginFeeNotification | null>;
  /**
   * The charges dated within a period, both ends inclusive, as "YYYY-MM-DD".
   * In date order, and in the order they were entered within a day.
   */
  charges(period: { from: string; to: string }): Promise<PluginMemberCharge[]>;
  /** One charge, or null where there is no such charge. */
  charge(id: string): Promise<PluginMemberCharge | null>;
  /**
   * Records that a notice or a charge was delivered, and returns the receipt.
   *
   * Idempotent: the same target, channel and reference from the same plugin
   * returns the receipt already recorded rather than a second one, so a job
   * retried after a crash cannot record one delivery twice. A reference that
   * holds a Swedish personal identity number is refused.
   */
  recordDelivery(
    input: PluginDeliveryReceiptInput,
  ): Promise<PluginDeliveryReceipt>;
  events: PluginFinanceEvents;
}

/**
 * A delivery the host would not record, and why.
 *
 * `reason` is stable and meant for the plugin's own code; the message is
 * English for the server log.
 */
export class PluginDeliveryRefusedError extends Error {
  constructor(
    readonly reason:
      | "target-not-found"
      | "channel-invalid"
      | "reference-invalid"
      | "reference-holds-personal-identity-number"
      | "delivered-at-invalid"
      | "delivered-in-the-future",
    message: string,
  ) {
    super(message);
    this.name = "PluginDeliveryRefusedError";
  }
}
