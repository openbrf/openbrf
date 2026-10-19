import { Injectable } from "@nestjs/common";

import type { RegisterReport } from "./register-report-content";

/**
 * The seam between what the association owes the cooperative housing register
 * and how a report reaches Lantmäteriet. ADR 0029.
 *
 * Everything on this side - what a report says, who may send it, what is
 * recorded - is built and tested. Everything on the other side is an adapter's:
 * the wire format, the endpoint, authentication, and reading Lantmäteriet's
 * answer back into one of the outcomes below. None of that can be written yet,
 * because the föreskrifter Förordning (2026:898) 2 kap. 2 § and 5 kap. 1-2 §§
 * leave it to have not been issued.
 */

/**
 * What Lantmäteriet answered.
 *
 * Two answers and no third. A transport failure, a timeout, an answer the
 * adapter cannot read - anything after which nobody knows whether the report
 * arrived - is thrown, and the service treats a throw as an unknown outcome.
 * An adapter that turned one of those into `rejected` would tell the board a
 * report had not arrived when it may have; one that turned it into `received`
 * would discharge a statutory duty on nothing.
 */
export type TransmissionOutcome =
  | {
      outcome: "received";
      /**
       * The day Lantmäteriet says the report came in, as YYYY-MM-DD.
       *
       * Lantmäteriet's day and not the platform's: Lag (2026:484) 3 kap. 2 and
       * 3 §§ make a registration take effect "vid den tidpunkt då en fullständig
       * anmälan kom in till Lantmäteriet", so this is the day the statute makes
       * operative and the one that can be checked against the register later.
       */
      receivedOn: string;
      /**
       * Lantmäteriet's own reference for the report: letters, digits and
       * `_ . / -`, up to a hundred characters, and nothing shaped like a
       * personal identity number. It is logged and kept on an append-only
       * entry, so the service refuses any other shape as an unknown outcome.
       */
      reference: string;
    }
  | {
      outcome: "rejected";
      /**
       * Lantmäteriet's reason codes, never its free text: they go into an audit
       * entry, which records facts about an act and no copied prose. Each is
       * letters, digits and `_ . : -`, up to sixty-four characters, and nothing
       * shaped like a personal identity number. An answer with any other shape
       * is an unknown outcome.
       */
      reasons: string[];
    };

export interface RegisterTransmission {
  /**
   * Whether anything is on the other side.
   *
   * Read before a row is loaded or a number decrypted, so an instance with no
   * adapter refuses a send without touching personal data.
   */
  readonly available: boolean;

  /**
   * Hands one report to Lantmäteriet and returns its answer.
   *
   * Must never answer `received` without a receipt from Lantmäteriet, and must
   * not quote the report in a thrown error or a log line: the report carries a
   * personal identity number.
   *
   * Must stop and throw once `signal` aborts, and hand it to whatever transport
   * carries the report. The service aborts it at its deadline and then lets go
   * of the duty's claim; an adapter still sending after that could put a second
   * report on the wire beside one a board member sends again.
   */
  submit(
    report: RegisterReport,
    options: { signal: AbortSignal },
  ): Promise<TransmissionOutcome>;
}

/** The injection token the registers module binds the transmission under. */
export const REGISTER_TRANSMISSION = Symbol("RegisterTransmission");

/**
 * What every instance is bound to until Lantmäteriet publishes an interface.
 *
 * Not a stub. A stub answers, and an answer of `received` from something that
 * is not Lantmäteriet would mark a duty discharged that nobody discharged: the
 * queue would stop showing it, the deadline would pass unwatched, and the first
 * anybody heard of it would be a föreläggande under 3 kap. 10 §. This answers
 * nothing - the service refuses before it gets here - and the board keeps
 * recording reports it made by hand, exactly as before.
 *
 * The stub the tests use is `RecordingRegisterTransmission` in src/testing,
 * which the production build excludes. `register-report.controller.spec.ts`
 * holds this binding.
 */
@Injectable()
export class UnavailableRegisterTransmission implements RegisterTransmission {
  readonly available = false;

  submit(): Promise<TransmissionOutcome> {
    return Promise.reject(
      new Error(
        "No transmission to the cooperative housing register is configured.",
      ),
    );
  }
}
