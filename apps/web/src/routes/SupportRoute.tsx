import { useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { SupportSignInScreen } from "../support/SupportSignInScreen";

/**
 * A supporter's sign-in link, without the application frame (ADR 0028).
 *
 * Like activation, and for the same reason: whoever is here has no session
 * yet, so there is no navigation to offer them. Once the session has started
 * they go to the overview, as anybody signing in does.
 */
export function SupportRoute(): ReactElement {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-page px-4">
      <SupportSignInScreen
        onSignedIn={() => {
          void navigate({ to: "/" });
        }}
      />
    </div>
  );
}
