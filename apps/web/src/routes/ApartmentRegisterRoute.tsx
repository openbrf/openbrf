import type { ReactElement } from "react";

import { ApartmentRegisterScreen } from "../registers/ApartmentRegisterScreen";
import { BoardPageRefused } from "../ui/BoardPage";
import { SignedInFrame } from "./SignedInFrame";

/**
 * The apartment register, the board's page.
 *
 * Mounted for an account holding the capability its endpoint requires. Anybody
 * else reads the sentence every refused board page says, under no sign, and
 * the register is never asked for. A tenant-owner's own entry, which BRL
 * 9 kap. entitles them to, is not here: it is a house page beside their
 * apartment binder (`OwnApartmentRegisterRoute`), because a page under /board
 * is the board's alone (ADR 0049).
 */
export function ApartmentRegisterRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) =>
        viewer.capabilities.includes("apartmentRegister:read") ? (
          <ApartmentRegisterScreen audience="board" />
        ) : (
          <BoardPageRefused />
        )
      }
    </SignedInFrame>
  );
}
