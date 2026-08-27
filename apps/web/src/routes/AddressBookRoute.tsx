import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { authClient, useSession } from "../auth/auth-client";
import { AppShell } from "../shell/AppShell";
import { NAV_ITEMS } from "../shell/nav-items";
import { ThemeModeToggle } from "../theme/ThemeModeToggle";

/**
 * The address book, still a placeholder.
 *
 * The frame, the session and the navigation are real; the register itself
 * arrives in the next stage. Kept deliberately thin so the shell can be
 * reviewed without a half-built board attached to it.
 */
export function AddressBookRoute(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: session } = useSession();

  return (
    <AppShell
      // The cooperative's real name arrives with the settings endpoint; until
      // then the frame is honest about not knowing it.
      housingCooperativeName={t("app.housingCooperative")}
      personName={session?.user.name}
      navItems={NAV_ITEMS}
      onSignOut={() => {
        /*
         * Navigating is part of signing out, not a nicety. The session is only
         * checked in this route's `beforeLoad`, so revoking it does not unmount
         * anything by itself: without this the register would stay on screen,
         * looking signed-in, until something else happened to trigger a load.
         */
        void authClient.signOut({
          fetchOptions: {
            onSuccess: () => {
              void navigate({ to: "/sign-in" });
            },
          },
        });
      }}
    >
      <div className="flex flex-col gap-5">
        <h1 className="text-display">{t("nav.addressBook")}</h1>
        <ThemeModeToggle />
      </div>
    </AppShell>
  );
}
