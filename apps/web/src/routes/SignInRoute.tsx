import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { fetchSignupState } from "../api/signup";
import { SignInScreen } from "../auth/SignInScreen";
import { authorizationRequestIn, consentHref } from "./authorization-request";
import { safeReturnTo } from "./return-to";

/**
 * The sign-in screen sits in the room, without the application frame.
 *
 * The way to the request form lives here rather than inside the sign-in screen
 * itself, for two reasons pointing the same way. That screen is rendered
 * without a router around it - by the tests, and by anything reusing the form -
 * and a link needs one. And whether a public request form exists at all is a
 * question about the instance rather than about signing in, so the read belongs
 * beside the route that knows the other screen exists. The link is offered only
 * while the board has the form switched on: pointing at a closed door is an
 * invitation to be turned away.
 *
 * Where a signed-in person lands is decided here rather than by the screen,
 * and there are three destinations. An app waiting to be told whether it may
 * act for this person gets the consent screen; somebody sent here from a route
 * they asked for goes back to it; anybody else goes to the start.
 */
export function SignInRoute(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ from: "/sign-in" });
  const [selfSignupOpen, setSelfSignupOpen] = useState(false);

  useEffect(() => {
    // The effect owns its own call and drops an answer that arrives after the
    // screen is gone.
    let active = true;
    void fetchSignupState().then((result) => {
      if (active) {
        setSelfSignupOpen(result.ok && result.value.enabled);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  /**
   * Where this sign-in ends.
   *
   * One function for every way of signing in, including the second factor:
   * the screen reports a session the same way whether it was a password, a
   * passkey or a code, and a destination worked out on only the first of them
   * would send anybody with an authenticator app to the wrong place.
   *
   * The authorization request is read from the unparsed search string and
   * appended to the consent screen's address as it stands, and the hop is a
   * document navigation - see the note in authorization-request.ts for what
   * the router would otherwise do to it.
   */
  const onSignedIn = (): void => {
    const request = authorizationRequestIn(window.location.search);
    if (request !== null) {
      void navigate({ href: consentHref(request), reloadDocument: true });
      return;
    }
    void navigate({ href: safeReturnTo(search.returnTo) ?? "/" });
  };

  return (
    <div className="min-h-screen bg-page px-4">
      <SignInScreen onSignedIn={onSignedIn} />

      {selfSignupOpen ? (
        <div className="mx-auto w-full max-w-sm pb-10">
          <Link
            to="/request-account"
            className="inline-flex min-h-11 items-center text-small text-ink underline"
          >
            {t("signIn.requestAccount")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
