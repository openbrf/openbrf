import type { ReactElement } from "react";

import { RequestAccountScreen } from "../signup/RequestAccountScreen";

/** The request form sits in the room, without the application frame. */
export function RequestAccountRoute(): ReactElement {
  return (
    <div className="min-h-screen bg-page px-4">
      <RequestAccountScreen />
    </div>
  );
}
