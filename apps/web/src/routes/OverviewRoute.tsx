import type { ReactElement } from "react";

import { OverviewScreen } from "../overview/OverviewScreen";
import { SignedInFrame } from "./SignedInFrame";

/** The overview inside the application frame. */
export function OverviewRoute(): ReactElement {
  return (
    <SignedInFrame>
      <OverviewScreen />
    </SignedInFrame>
  );
}
