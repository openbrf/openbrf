/**
 * Test support shared by the integration suites and the end-to-end specs.
 *
 * Exported as `@openbrf/shared/testing` rather than from the main entry, so
 * nothing an application ships can import a fixture generator by accident.
 */
export { testPersonalIdentityNumber } from "./personal-identity-number.ts";
