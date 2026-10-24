import type { ReactElement } from "react";

import { ImportScreen } from "../import/ImportScreen";
import { isOffered } from "../shell/nav-items";
import { BoardPageRefused } from "../ui/BoardPage";
import { SignedInFrame } from "./SignedInFrame";

/**
 * The one-time import of an existing member list.
 *
 * One of the board's pages, mounted for the accounts the band offers it to.
 * Anybody else reads the sentence every refused board page says, under no sign.
 */
export function ImportRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) =>
        isOffered(viewer.capabilities, "/board/import") ? (
          <ImportScreen />
        ) : (
          <BoardPageRefused />
        )
      }
    </SignedInFrame>
  );
}
