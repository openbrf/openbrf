import { startStack } from "./stack";

/**
 * Brings up the stack the suite runs against.
 *
 * Set OPENBRF_E2E_REUSE_STACK=true to run against a stack that is already up.
 * That skips the rebuild while a spec is being written; it also skips the fresh
 * volumes the first-boot spec needs, so a full run never uses it.
 */
export default function globalSetup(): void {
  if (process.env.OPENBRF_E2E_REUSE_STACK === "true") {
    return;
  }
  startStack();
}
