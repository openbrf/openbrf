import { getRouteApi, useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { ActivateScreen } from "../activate/ActivateScreen";

const route = getRouteApi("/activate");

/**
 * Activation sits in the room, without the application frame.
 *
 * Like sign-in, and for the same reason: whoever is here has no session yet, so
 * there is no navigation to offer them and nothing in the shell that would
 * render.
 */
export function ActivateRoute(): ReactElement {
  const navigate = useNavigate();
  const { token } = route.useSearch();

  return (
    <div className="min-h-screen bg-page px-4">
      <ActivateScreen
        token={token}
        onActivated={() => {
          void navigate({ to: "/" });
        }}
      />
    </div>
  );
}
