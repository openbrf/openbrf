import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchViewer } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { FeedScreen } from "../feed/FeedScreen";
import { PostScreen } from "../feed/PostScreen";
import { AppShell } from "../shell/AppShell";
import { navItemsFor } from "../shell/nav-items";
import { applyAccentOverride } from "../theme/accent-override";
import { Notice } from "../ui/Notice";

/**
 * The feed, inside the application frame.
 *
 * The viewer is loaded here rather than in the screen so the band can carry the
 * housing cooperative's real name and its accent colour, and so the navigation is
 * the one this account is actually offered. The identifier arrives with the same
 * request, which is what the screen reads to tell a reader's own post from a
 * neighbour's.
 *
 * The guard asks only for a session, like every route in this file. Whether this
 * account may reach the endpoints is `chat:participate`, decided by the API; and
 * which audiences there are for them is their residency, their board seat and
 * their groups, which is a second question the screen puts into words rather
 * than a capability.
 */
export function FeedRoute(): ReactElement {
  return <FeedFrame>{(viewer) => <FeedScreen viewer={viewer} />}</FeedFrame>;
}

/**
 * One post at its own address, inside the same frame.
 *
 * The identifier is handed to the screen as it arrived. Whether it names a post
 * this account may read is the API's answer, and the screen renders the refusal
 * for one it may not exactly as for one that does not exist.
 */
export function PostRoute(): ReactElement {
  const { postId } = useParams({ from: "/feed/$postId" });
  return (
    <FeedFrame>
      {(viewer) => <PostScreen viewer={viewer} postId={postId} />}
    </FeedFrame>
  );
}

function FeedFrame({
  children,
}: {
  children: (viewer: Viewer) => ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const load = async (): Promise<void> => {
      const result = await fetchViewer();
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setViewer(result.value);
      applyAccentOverride(
        result.value.housingCooperative?.primaryColor ?? null,
      );
    };

    void load();
  }, []);

  return (
    <AppShell
      housingCooperativeName={
        viewer?.housingCooperative?.name ?? t("app.housingCooperative")
      }
      logo={{
        light: viewer?.housingCooperative?.logoUrl ?? null,
        dark: viewer?.housingCooperative?.logoDarkUrl ?? null,
      }}
      personName={
        viewer === null
          ? undefined
          : `${viewer.firstName} ${viewer.lastName}`.trim()
      }
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
      {failed ? (
        <Notice tone="danger" live>
          {t("feed.loadFailed")}
        </Notice>
      ) : viewer === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("feed.loading")}
        </p>
      ) : (
        children(viewer)
      )}
    </AppShell>
  );
}
