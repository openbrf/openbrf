import type { ReactElement } from "react";

import { InitialSupplyScreen } from "../registers/InitialSupplyScreen";
import { BoardPageRefused } from "../ui/BoardPage";
import { SignedInFrame } from "./SignedInFrame";

/**
 * The initial supply to the cooperative housing register.
 *
 * One of the board's pages, reached from the report queue and offered to whoever
 * the queue is: an account that may read the apartment register. Anybody else
 * reads the sentence every refused board page says, under no sign.
 *
 * The supply itself sits behind a capability of its own, and the screen
 * produces nothing until somebody presses the button, so a board member who may
 * read the register and not supply it is still shown the page and told so by
 * the API's refusal rather than by this route.
 */
export function InitialSupplyRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) =>
        viewer.capabilities.includes("apartmentRegister:read") ? (
          <InitialSupplyScreen />
        ) : (
          <BoardPageRefused />
        )
      }
    </SignedInFrame>
  );
}
