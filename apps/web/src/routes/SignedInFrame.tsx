import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient, useSession } from "../auth/auth-client";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";

/**
 * The application frame around a signed-in screen.
 *
 * The register views and the import all need the same band, the same
 * navigation and the same sign-out, and signing out has to navigate as well as
 * revoke: the session is only checked in a route's beforeLoad, so revoking it
 * unmounts nothing by itself and the screen would stay on until something else
 * happened to trigger a load.
 *
 * The viewer is read for the navigation alone. Which destinations an account is
 * offered follows from its capabilities, and the session says who is signed in
 * without saying what they may reach - so a frame built on the session alone
 * would show every account the same band, including the links its own seat
 * cannot use.
 */
export function SignedInFrame({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [viewer, setViewer] = useState<Viewer | null>(null);

  useEffect(() => {
    // The frame owns its own call and drops a response that arrives after it is
    // gone, rather than applying it to a component nobody is looking at.
    let active = true;
    void fetchViewer().then((result) => {
      if (active && result.ok) {
        setViewer(result.value);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <AppShell
      housingCooperativeName={t("app.housingCooperative")}
      personName={session?.user.name}
      // Undefined until the answer arrives, which navItemsFor reads as "the
      // viewer is not known yet" and answers with the destinations every
      // account is offered. The band therefore only gains links once the
      // capabilities land, and never shows one it has to take away again.
      navItems={navItemsFor(viewer?.capabilities)}
      onSignOut={() => {
        void authClient.signOut({
          fetchOptions: {
            onSuccess: () => {
              void navigate({ to: "/sign-in" });
            },
          },
        });
      }}
    >
      {children}
    </AppShell>
  );
}
