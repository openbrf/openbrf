import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { fetchSetupState } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { AddressBookRoute } from "./AddressBookRoute";
import { PluginsRoute } from "./PluginsRoute";
import { PluginViewRoute } from "./PluginViewRoute";
import { SettingsRoute } from "./SettingsRoute";
import { SetupRoute } from "./SetupRoute";
import { SignInRoute } from "./SignInRoute";

/**
 * Routes.
 *
 * Access is decided in `beforeLoad` against the server's session rather than in
 * a component, so a protected route never renders even briefly for someone who
 * is not signed in. Rendering first and redirecting afterwards would flash the
 * register.
 *
 * The session is fetched from the API on each guard rather than trusted from
 * local state: the API is the authority, and a client-side flag would be a
 * guess about what the server will allow.
 */
async function hasSession(): Promise<boolean> {
  const { data } = await authClient.getSession();
  return data !== null && data !== undefined;
}

/**
 * Whether the instance is still unclaimed.
 *
 * False on any failure, which is the safe direction: a wrong "true" would send a
 * signed-in board member into a setup wizard, while a wrong "false" only sends a
 * fresh instance's operator to the sign-in screen, from where /setup is one link
 * away.
 */
async function needsSetup(): Promise<boolean> {
  const result = await fetchSetupState();
  return result.ok && result.value.setupRequired;
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  beforeLoad: async () => {
    // Someone already signed in has no business on this screen.
    if (await hasSession()) {
      throw redirect({ to: "/" });
    }
    // On an unclaimed instance there is no account to sign in with, so the
    // wizard is the only useful destination.
    if (await needsSetup()) {
      throw redirect({ to: "/setup" });
    }
  },
  component: SignInRoute,
});

/**
 * The setup wizard.
 *
 * Deliberately without a session guard: on first boot there is no account to
 * authenticate with, which is the entire point of the screen. It asks the server
 * whether the instance is unclaimed and shows a closed notice when it is not,
 * and the API refuses every write an unauthenticated caller is not entitled to
 * make. Guarding this route on a session would make first boot impossible;
 * leaving it unguarded is safe only because the API does not rely on this guard,
 * and it does not.
 */
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupRoute,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: async () => {
    if (!(await hasSession())) {
      throw redirect({ to: "/sign-in" });
    }
  },
  component: SettingsRoute,
});

const pluginsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plugins",
  beforeLoad: async () => {
    if (!(await hasSession())) {
      throw redirect({ to: "/sign-in" });
    }
  },
  component: PluginsRoute,
});

/**
 * A plugin's own screen.
 *
 * Only a session is required here. Which plugin views a person may open is the
 * API's decision, and the screen shows "no such view" for one this account is
 * not offered - a capability check in this guard would be a second opinion
 * that could disagree with the server's.
 */
const pluginViewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plugin/$pluginId",
  beforeLoad: async () => {
    if (!(await hasSession())) {
      throw redirect({ to: "/sign-in" });
    }
  },
  component: PluginViewRoute,
});

const addressBookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    if (!(await hasSession())) {
      // A fresh instance serves the wizard rather than a sign-in screen nobody
      // has an account for (plan exit criterion 1).
      throw redirect({ to: (await needsSetup()) ? "/setup" : "/sign-in" });
    }
  },
  component: AddressBookRoute,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  setupRoute,
  settingsRoute,
  pluginsRoute,
  pluginViewRoute,
  addressBookRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
