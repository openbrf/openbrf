import type { ReactElement } from "react";

import { BinderBoardScreen } from "../apartment-binder/BinderBoardScreen";
import { BoardFrontScreen } from "../board/BoardFrontScreen";
import { BookingBoardScreen } from "../bookings/BookingBoardScreen";
import { DocumentBoardScreen } from "../documents/DocumentBoardScreen";
import { EventBoardScreen } from "../events/EventBoardScreen";
import { ReportQueueScreen } from "../feed/ReportQueueScreen";
import { IssueQueueScreen } from "../issues/IssueQueueScreen";
import { KeyOrderQueueScreen } from "../key-orders/KeyOrderQueueScreen";
import { MotionQueueScreen } from "../motions/MotionQueueScreen";
import { SubletQueueScreen } from "../sublets/SubletQueueScreen";
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

/** "Handle motions". */
export function MotionQueueRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) => <MotionQueueScreen viewer={viewer} />}
    </SignedInFrame>
  );
}

/** "Decide applications". */
export function SubletQueueRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) => <SubletQueueScreen viewer={viewer} />}
    </SignedInFrame>
  );
}

/** "Handle orders": the keys and tags ordered. */
export function KeyOrderQueueRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) => <KeyOrderQueueScreen viewer={viewer} />}
    </SignedInFrame>
  );
}

/** "Review reported posts". */
export function ReportQueueRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) => <ReportQueueScreen viewer={viewer} />}
    </SignedInFrame>
  );
}

/** "Every apartment's binder". */
export function BinderBoardRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) => <BinderBoardScreen viewer={viewer} />}
    </SignedInFrame>
  );
}

/** "Manage events". */
export function EventBoardRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) => <EventBoardScreen viewer={viewer} />}
    </SignedInFrame>
  );
}

/** "Manage the archive". */
export function DocumentBoardRoute(): ReactElement {
  return (
    <SignedInFrame>
      {(viewer) => <DocumentBoardScreen viewer={viewer} />}
    </SignedInFrame>
  );
}
