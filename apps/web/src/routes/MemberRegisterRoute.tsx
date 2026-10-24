import type { ReactElement } from "react";

import { MemberRegisterScreen } from "../registers/MemberRegisterScreen";
import { BoardPageRefused } from "../ui/BoardPage";
import { SignedInFrame } from "./SignedInFrame";

/**
 * The member register.
 *
 * Its own route. The apartment register has another one, and there is no route
 * that serves both: the two are separate statutory documents, and a single
 * screen with a toggle would be one wrong default away from handing out the
 * confidential one.
 *
 * One of the board's pages, mounted for an account holding the capability its
 * endpoint requires. Anybody else reads the sentence every refused board page
 * says, under no sign, and the register is never asked for.
 */
export function MemberRegisterRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) =>
        viewer.capabilities.includes("memberRegister:read") ? (
          <MemberRegisterScreen />
        ) : (
          <BoardPageRefused />
        )
      }
    </SignedInFrame>
  );
}
