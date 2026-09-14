import { useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { OAuthConsentScreen } from "../connected-apps/OAuthConsentScreen";

/**
 * The consent screen sits in the room, without the application frame.
 *
 * Deliberately, on the sign-in screen's reasoning: the member is in the middle
 * of one decision that another program is waiting on, and a navigation band
 * around it is an invitation to wander off and leave the app hanging. The two
 * ways out are on the screen itself.
 *
 * The search string is read from the document rather than from the router. The
 * router parses a search string into an object and serialises it back for
 * everything it builds, and that round trip keeps one value per parameter
 * name - while an authorization request repeats one, and is signed over what it
 * repeats. So what the router holds is a re-spelled request whose signature no
 * longer verifies, and what the document holds is the request. See the note in
 * authorization-request.ts.
 */
export function OAuthConsentRoute(): ReactElement {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-page px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <OAuthConsentScreen
          authorizationRequest={window.location.search}
          onGranted={(redirectUri) => {
            // Out of this application and back to the app that asked, at the
            // address the instance answered with rather than one composed
            // here: where an authorization code may be sent is the server's
            // decision, and a second composition could disagree with it.
            window.location.assign(redirectUri);
          }}
          onLeave={() => {
            void navigate({ to: "/" });
          }}
        />
      </div>
    </div>
  );
}
