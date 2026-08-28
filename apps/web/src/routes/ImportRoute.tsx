import type { ReactElement } from "react";

import { ImportScreen } from "../import/ImportScreen";
import { SignedInFrame } from "./SignedInFrame";

/** The one-time import of an existing member list. */
export function ImportRoute(): ReactElement {
  return (
    <SignedInFrame>
      <ImportScreen />
    </SignedInFrame>
  );
}
