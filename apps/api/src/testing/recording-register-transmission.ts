import {
  type RegisterReport,
  registerReportSchema,
} from "../registers/register-report-content";
import type {
  RegisterTransmission,
  TransmissionOutcome,
} from "../registers/register-transmission";

/**
 * The stand-in for Lantmäteriet that the tests bind with `overrideProvider`.
 * ADR 0029.
 *
 * Here and not beside the port, because src/testing is excluded from the
 * production build: nothing an association runs can reach this class, and no
 * environment variable or setting selects it. An answer of `received` from it on
 * a real instance would discharge a statutory duty that went nowhere.
 *
 * It does three things a real adapter would, so the service is tested against
 * the contract and not against a mock that accepts anything:
 *
 *   - it refuses a report that does not pass `registerReportSchema`, as a
 *     rejection with the code `CONTRACT`, so a service that sent something the
 *     contract does not allow fails the test that sent it;
 *   - it records every report it was handed, in order;
 *   - it answers with what the test scripted - received, rejected, a throw, or
 *     any of those after a wait the test releases - and stops with a throw the
 *     moment its signal aborts, as the port requires of an adapter.
 */
export class RecordingRegisterTransmission implements RegisterTransmission {
  available = true;

  /** Every report handed over, in order, including ones it then refused. */
  readonly submitted: RegisterReport[] = [];
  /** The signal each submission was handed, in the same order. */
  readonly signals: AbortSignal[] = [];

  private script: Array<() => Promise<TransmissionOutcome>> = [];
  private receipts = 0;

  /** Answers the next submission as received, on the day given. */
  receiveNext(receivedOn: string): this {
    this.script.push(() => {
      this.receipts += 1;
      return Promise.resolve({
        outcome: "received",
        receivedOn,
        reference: `LM-STUB-${String(this.receipts).padStart(6, "0")}`,
      });
    });
    return this;
  }

  /** Answers the next submission as rejected, with these codes. */
  rejectNext(...reasons: string[]): this {
    this.script.push(() => Promise.resolve({ outcome: "rejected", reasons }));
    return this;
  }

  /** Throws on the next submission: an outcome nobody knows. */
  failNext(error: Error): this {
    this.script.push(() => Promise.reject(error));
    return this;
  }

  /** Answers the next submission with whatever the test supplies. */
  answerNext(answer: () => Promise<TransmissionOutcome>): this {
    this.script.push(answer);
    return this;
  }

  /** Forgets the script and the record, between tests. */
  reset(): void {
    this.available = true;
    this.submitted.length = 0;
    this.signals.length = 0;
    this.script = [];
  }

  async submit(
    report: RegisterReport,
    { signal }: { signal: AbortSignal },
  ): Promise<TransmissionOutcome> {
    this.submitted.push(report);
    this.signals.push(signal);
    signal.throwIfAborted();
    if (!registerReportSchema.safeParse(report).success) {
      return { outcome: "rejected", reasons: ["CONTRACT"] };
    }
    const next = this.script.shift();
    if (next === undefined) {
      throw new Error("RecordingRegisterTransmission was given no answer.");
    }
    return new Promise<TransmissionOutcome>((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(signal.reason);
        },
        { once: true },
      );
      next().then(resolve, reject);
    });
  }
}
