import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { fetchSignupState } from "../api/signup";
import { SignInScreen } from "../auth/SignInScreen";

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
 */
export function SignInRoute(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
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

  return (
    <div className="min-h-screen bg-page px-4">
      <SignInScreen
        onSignedIn={() => {
          void navigate({ to: "/" });
        }}
      />

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
