import type { ReactElement } from "react";

import { ApartmentRegisterScreen } from "../registers/ApartmentRegisterScreen";
import { SignedInFrame } from "./SignedInFrame";

/**
 * A tenant-owner's own entry in the apartment register, a house page.
 *
 * BRL 9 kap. entitles the holder of a tenant-ownership to their own entry and
 * nobody else's. It sits beside the apartment binder, which links to it,
 * rather than under /board: it is the same page for a board member who holds
 * an apartment as for their neighbour, and opening it keeps the resident
 * preview (ADR 0049).
 *
 * Deliberately no capability, for the binder's reason: whose entry this is
 * follows the tenant-ownerships the session's person holds today, which is the
 * server's answer and no capability expresses. The screen asks for the own
 * entry alone, never the board's register.
 */
export function OwnApartmentRegisterRoute(): ReactElement {
  return (
    <SignedInFrame>
      <ApartmentRegisterScreen audience="holder" />
    </SignedInFrame>
  );
}
