import type { ReactElement } from "react";

import { InitialSupplyScreen } from "../registers/InitialSupplyScreen";
import { SignedInFrame } from "./SignedInFrame";

/**
 * The initial supply to the cooperative housing register.
 *
 * The route only requires a session. The supply itself sits behind a capability
 * of its own, and the screen produces nothing until somebody presses the button,
 * so reaching this path discloses nothing: a capability check in the guard would
 * be a second opinion about a decision the API already owns.
 */
export function InitialSupplyRoute(): ReactElement {
  return (
    <SignedInFrame>
      <InitialSupplyScreen />
    </SignedInFrame>
  );
}
