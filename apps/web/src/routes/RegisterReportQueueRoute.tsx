import type { ReactElement } from "react";

import { RegisterReportQueueScreen } from "../registers/RegisterReportQueueScreen";
import { BoardPageRefused } from "../ui/BoardPage";
import { SignedInFrame } from "./SignedInFrame";

/**
 * The queue of duties towards the cooperative housing register.
 *
 * One of the board's pages. The queue is gated on the capability that gates
 * the apartment register, so it is mounted for an account holding that, and
 * anybody else reads the sentence every refused board page says, under no
 * sign. The server decides what the queue holds either way.
 */
export function RegisterReportQueueRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) =>
        viewer.capabilities.includes("apartmentRegister:read") ? (
          <RegisterReportQueueScreen />
        ) : (
          <BoardPageRefused />
        )
      }
    </SignedInFrame>
  );
}
