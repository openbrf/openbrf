import { useSearch } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { ApartmentRegisterScreen } from "../registers/ApartmentRegisterScreen";
import { SignedInFrame } from "./SignedInFrame";

/**
 * The apartment register's search: `view=own`, or nothing.
 *
 * `view=own` is the household's entry point to its own register entry: it
 * opens that view even for an account that also holds board capabilities.
 * Anything else is the board's register, as the server answers it.
 */
export function validateApartmentRegisterSearch(
  search: Record<string, unknown>,
): { view?: "own" } {
  return search.view === "own" ? { view: "own" } : {};
}

/**
 * The apartment register.
 *
 * Open to any signed-in person, because a tenant-owner is entitled to their own
 * entry (BRL 9 kap.). What they receive is decided by the server: the screen
 * asks for the board's register and takes a refusal as the answer that this
 * viewer sees only their own apartment. `view=own` in the address asks for
 * that own entry outright, which is what the household's link to it does.
 *
 * Each view is a screen of its own, keyed by the view. Moving between the two
 * changes only the search, which would otherwise keep the one screen and
 * everything it holds: the board's extract left on screen under the own
 * entry's address when the own entry cannot be read, or a full extract the
 * board asked for arriving after the own entry was opened.
 */
export function ApartmentRegisterRoute(): ReactElement {
  const { view } = useSearch({ from: "/board/registers/apartments" });
  const ownOnly = view === "own";

  return (
    <SignedInFrame>
      <ApartmentRegisterScreen
        key={ownOnly ? "own" : "board"}
        ownOnly={ownOnly}
      />
    </SignedInFrame>
  );
}
