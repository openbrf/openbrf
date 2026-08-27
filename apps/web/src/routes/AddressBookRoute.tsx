import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { authClient, useSession } from "../auth/auth-client";
import { AppShell, type NavItem } from "../shell/AppShell";
import { ThemeModeToggle } from "../theme/ThemeModeToggle";

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", labelKey: "nav.addressBook" },
];

/**
 * The address book, still a placeholder.
 *
 * The frame, the session and the navigation are real; the register itself
 * arrives in the next stage. Kept deliberately thin so the shell can be
 * reviewed without a half-built board attached to it.
 */
export function AddressBookRoute(): ReactElement {
  const { t } = useTranslation();
  const { data: session } = useSession();

  return (
    <AppShell
      // The association's real name arrives with the settings endpoint; until
      // then the frame is honest about not knowing it.
      associationName={t("app.association")}
      personName={session?.user.name}
      navItems={NAV_ITEMS}
      onSignOut={() => {
        void authClient.signOut();
      }}
    >
      <div className="flex flex-col gap-5">
        <h1 className="text-display">{t("nav.addressBook")}</h1>
        <ThemeModeToggle />
      </div>
    </AppShell>
  );
}
