import { stopStack } from "./stack";

/**
 * Removes the stack and its volumes.
 *
 * Set OPENBRF_E2E_KEEP_STACK=true to leave it running and inspect the instance
 * a failing spec left behind.
 */
export default function globalTeardown(): void {
  if (
    process.env.OPENBRF_E2E_KEEP_STACK === "true" ||
    process.env.OPENBRF_E2E_REUSE_STACK === "true"
  ) {
    return;
  }
  stopStack();
}
