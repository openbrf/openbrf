import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Unmounts rendered components between tests.
 *
 * Testing Library does this automatically only when Vitest runs with
 * `globals: true`. This project keeps globals off and imports test helpers
 * explicitly, so cleanup has to be wired up here. Without it the DOM
 * accumulates across tests in a file, and a query like getAllByRole("radio")
 * silently returns the controls from every previous test as well - which reads
 * as a component bug rather than a missing teardown.
 */
afterEach(() => {
  cleanup();
});
