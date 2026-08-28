import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { ReactElement, ReactNode } from "react";

import { authClient, useSession } from "../auth/auth-client";
import { AppShell } from "../shell/AppShell";
import { NAV_ITEMS } from "../shell/nav-items";

/**
 * The application frame around a signed-in screen.
 *
 * The register views and the import all need the same band, the same
 * navigation and the same sign-out, and signing out has to navigate as well as
 * revoke: the session is only checked in a route's beforeLoad, so revoking it
 * unmounts nothing by itself and the screen would stay on until something else
 * happened to trigger a load.
 */
export function SignedInFrame({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: session } = useSession();

  return (
    <AppShell
      housingCooperativeName={t("app.housingCooperative")}
      personName={session?.user.name}
      navItems={NAV_ITEMS}
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
