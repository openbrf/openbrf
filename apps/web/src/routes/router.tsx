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
import { ApartmentRegisterRoute } from "./ApartmentRegisterRoute";
import { ImportRoute } from "./ImportRoute";
import { MemberRegisterRoute } from "./MemberRegisterRoute";
import { SettingsRoute } from "./SettingsRoute";
import { SetupRoute } from "./SetupRoute";
import { SignInRoute } from "./SignInRoute";
import { ThemesRoute } from "./ThemesRoute";

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

/** Sends anyone without a session to sign in, before the screen renders. */
async function requireSession(): Promise<void> {
  if (!(await hasSession())) {
    throw redirect({ to: "/sign-in" });
  }
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: requireSession,
  component: SettingsRoute,
});

/**
 * Theme management. Signed in here, administrator inside the screen.
 *
 * The capability is checked by the screen and enforced by the API; this guard
 * only keeps the route from rendering for someone with no session at all.
 */
const themesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/themes",
  beforeLoad: requireSession,
  component: ThemesRoute,
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

/**
 * The two statutory registers, on two routes.
 *
 * Separate paths rather than one screen with a parameter: the member register
 * is public on request and the apartment register is confidential, and a single
 * route serving both would be one wrong value away from handing out the wrong
 * one. Access is the API's decision - both routes only require a session, and
 * the endpoints behind them refuse what the viewer is not entitled to.
 */
const memberRegisterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/registers/members",
  beforeLoad: requireSession,
  component: MemberRegisterRoute,
});

const apartmentRegisterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/registers/apartments",
  beforeLoad: requireSession,
  component: ApartmentRegisterRoute,
});

const importRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/import",
  beforeLoad: requireSession,
  component: ImportRoute,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  setupRoute,
  settingsRoute,
  themesRoute,
  memberRegisterRoute,
  apartmentRegisterRoute,
  importRoute,
  addressBookRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
