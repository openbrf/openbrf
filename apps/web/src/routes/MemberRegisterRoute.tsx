import type { ReactElement } from "react";

import { MemberRegisterScreen } from "../registers/MemberRegisterScreen";
import { SignedInFrame } from "./SignedInFrame";

/**
 * The member register.
 *
 * Its own route. The apartment register has another one, and there is no route
 * that serves both: the two are separate statutory documents, and a single
 * screen with a toggle would be one wrong default away from handing out the
 * confidential one.
 */
export function MemberRegisterRoute(): ReactElement {
  return (
    <SignedInFrame>
      <MemberRegisterScreen />
    </SignedInFrame>
  );
}
