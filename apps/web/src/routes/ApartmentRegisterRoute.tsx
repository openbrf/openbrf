import type { ReactElement } from "react";

import { ApartmentRegisterScreen } from "../registers/ApartmentRegisterScreen";
import { SignedInFrame } from "./SignedInFrame";

/**
 * The apartment register.
 *
 * Open to any signed-in person, because a tenant-owner is entitled to their own
 * entry (BRL 9 kap.). What they receive is decided by the server: the screen
 * asks for the board's register and takes a refusal as the answer that this
 * viewer sees only their own apartment.
 */
export function ApartmentRegisterRoute(): ReactElement {
  return (
    <SignedInFrame>
      <ApartmentRegisterScreen />
    </SignedInFrame>
  );
}
