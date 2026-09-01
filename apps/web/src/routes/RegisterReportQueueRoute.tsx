import type { ReactElement } from "react";

import { RegisterReportQueueScreen } from "../registers/RegisterReportQueueScreen";
import { SignedInFrame } from "./SignedInFrame";

/**
 * The queue of duties towards the cooperative housing register.
 *
 * Open to any signed-in person, like both register routes, and what the viewer
 * receives is the server's decision: the queue is gated on the capability that
 * gates the apartment register, so a resident is refused there rather than here.
 */
export function RegisterReportQueueRoute(): ReactElement {
  return (
    <SignedInFrame>
      <RegisterReportQueueScreen />
    </SignedInFrame>
  );
}
