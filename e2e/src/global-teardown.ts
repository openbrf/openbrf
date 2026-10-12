import { saveStackLogs, stopStack } from "./stack";

/**
 * Saves the stack's logs, then removes the stack and its volumes.
 *
 * The logs are saved on every run, kept or not, because a failure is only known
 * to be worth explaining once it has happened, and by then `down` would have
 * taken them with the containers.
 *
 * Set OPENBRF_E2E_KEEP_STACK=true to leave it running and inspect the instance
 * a failing spec left behind.
 */
export default function globalTeardown(): void {
  saveStackLogs();
  if (
    process.env.OPENBRF_E2E_KEEP_STACK === "true" ||
    process.env.OPENBRF_E2E_REUSE_STACK === "true"
  ) {
    return;
  }
  stopStack();
}
