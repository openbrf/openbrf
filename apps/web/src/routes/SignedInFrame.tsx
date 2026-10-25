import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient, useSession } from "../auth/auth-client";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { applyAccentOverride } from "../theme/accent-override";
import { LoadFailure } from "../ui/LoadFailure";

/**
 * The application frame around a signed-in screen.
 *
 * The register views and the import all need the same band, the same
 * navigation and the same sign-out, and signing out has to navigate as well as
 * revoke: the session is only checked in a route's beforeLoad, so revoking it
 * unmounts nothing by itself and the screen would stay on until something else
 * happened to trigger a load.
 *
 * The viewer is read for the navigation, and for the association's name and
 * logo in the band. Which destinations an account is offered follows from its
 * capabilities, and the session says who is signed in without saying what they
 * may reach - so a frame built on the session alone would show every account
 * the same band, including the links its own seat cannot use.
 *
 * The same answer carries the association's accent colour, which the frame
 * applies to the page once it has arrived.
 *
 * A screen that needs the viewer as well - each of the board's pages decides
 * from its capabilities whether it is offered - is given it as a function of
 * it, and rendered once it has arrived, so the frame's one read serves both.
 */
export function SignedInFrame({
  children,
}: {
  children: ReactNode | ((viewer: Viewer) => ReactNode);
}): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // The frame owns its own call and drops a response that arrives after it is
    // gone, rather than applying it to a component nobody is looking at.
    let active = true;
    void fetchViewer().then((result) => {
      if (!active) {
        return;
      }
      if (result.ok) {
        setViewer(result.value);
        // The association's own accent, applied here so that a page opened by
        // its address - a fresh load or a refresh - carries it too. The
        // override is a style element in the document, so moving between pages
        // keeps it; a page that is the first one loaded has nothing else that
        // would put it there.
        applyAccentOverride(
          result.value.housingCooperative?.primaryColor ?? null,
        );
      } else {
        setFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <AppShell
      housingCooperativeName={
        viewer?.housingCooperative?.name ?? t("app.housingCooperative")
      }
      // The association's own mark, from the same answer. The overview is the
      // page every sign-in lands on, and the band there carries the logo the
      // board uploaded exactly as every other screen's does.
      logo={{
        light: viewer?.housingCooperative?.logoUrl ?? null,
        dark: viewer?.housingCooperative?.logoDarkUrl ?? null,
      }}
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
      {typeof children !== "function" ? (
        children
      ) : viewer !== null ? (
        children(viewer)
      ) : failed ? (
        <LoadFailure
          messageKey="boardPage.loadFailed"
          onRetry={() => {
            setFailed(false);
            setAttempt((count) => count + 1);
          }}
        />
      ) : (
        <p role="status" className="text-body text-ink-muted">
          {t("app.loading")}
        </p>
      )}
    </AppShell>
  );
}
