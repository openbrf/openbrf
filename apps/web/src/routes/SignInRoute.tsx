import { useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { SignInScreen } from "../auth/SignInScreen";

/** The sign-in screen sits in the room, without the application frame. */
export function SignInRoute(): ReactElement {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-page px-4">
      <SignInScreen
        onSignedIn={() => {
          void navigate({ to: "/" });
        }}
      />
    </div>
  );
}
