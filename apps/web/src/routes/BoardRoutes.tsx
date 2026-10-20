import type { ReactElement } from "react";

import { BoardFrontScreen } from "../board/BoardFrontScreen";
import { BookingBoardScreen } from "../bookings/BookingBoardScreen";
import { IssueQueueScreen } from "../issues/IssueQueueScreen";
import { SignedInFrame } from "./SignedInFrame";

/*
 * The board's pages made for it, each inside the application frame. The frame
 * reads the viewer once, for the band and for the page, and each page decides
 * from the viewer's capabilities whether it is offered.
 */

/** The board's front page, "To handle". */
export function BoardFrontRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) => <BoardFrontScreen viewer={viewer} />}
    </SignedInFrame>
  );
}

/** "Handle issues". */
export function IssueQueueRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) => <IssueQueueScreen viewer={viewer} />}
    </SignedInFrame>
  );
}

/** "Handle bookings". */
export function BookingBoardRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) => <BookingBoardScreen viewer={viewer} />}
    </SignedInFrame>
  );
}
