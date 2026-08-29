import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { fetchSetupState } from "../api/instance";
import { authClient } from "../auth/auth-client";
import { ActivateRoute } from "./ActivateRoute";
import { AddressBookRoute } from "./AddressBookRoute";
import { ApartmentRegisterRoute } from "./ApartmentRegisterRoute";
import { ImportRoute } from "./ImportRoute";
import { IssuesRoute } from "./IssuesRoute";
import { MemberRegisterRoute } from "./MemberRegisterRoute";
import { PluginsRoute } from "./PluginsRoute";
import { PluginViewRoute } from "./PluginViewRoute";
import { RequestAccountRoute } from "./RequestAccountRoute";
import { SettingsRoute } from "./SettingsRoute";
import { SetupRoute } from "./SetupRoute";
import { SignInRoute } from "./SignInRoute";
import { ThemeComposerRoute } from "./ThemeComposerRoute";
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
 * The public request-an-account form.
 *
 * Signed-in visitors are sent away exactly as they are from the sign-in screen:
 * they already have the account this form asks for. There is no unclaimed-
 * instance redirect beside it, because self-signup is off until a board
 * switches it on - a fresh instance therefore answers "closed" here on its own,
 * and the wizard has nothing to offer somebody who wants an account on a
 * cooperative that does not exist yet.
 */
const requestAccountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/request-account",
  beforeLoad: async () => {
    if (await hasSession()) {
      throw redirect({ to: "/" });
    }
  },
  component: RequestAccountRoute,
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

/**
 * Activation, reached from the link in an invitation email.
 *
 * Deliberately without a session guard, like the wizard above and for the same
 * kind of reason: the person has no account yet, which is the entire point of
 * the screen. The token in the query string is the credential, and the API
 * checks it, refuses an expired or already-used one, and creates nothing for a
 * caller who does not hold one - so a guard here would add nothing and would
 * shut out exactly the people the screen exists for.
 */
const activateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activate",
  /*
   * The token is coerced rather than validated. A link mangled on its way
   * through a mail client should reach the screen and be told that the link
   * does not work, not throw a router error at somebody who only clicked what
   * they were sent.
   */
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: ActivateRoute,
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

/**
 * The theme composer. `?theme=` names the composed theme being edited.
 *
 * The search parameter is validated rather than read raw: it reaches an API
 * path, and a route that passed on whatever the address bar held would make the
 * address bar an input to a request. Anything that is not a theme id is dropped
 * and the screen composes a new theme instead.
 */
const themeComposerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/themes/compose",
  validateSearch: (search: Record<string, unknown>): { theme?: string } => {
    const theme = search["theme"];
    return typeof theme === "string" && /^[a-z][a-z0-9-]{1,63}$/.test(theme)
      ? { theme }
      : {};
  },
  beforeLoad: requireSession,
  component: ThemeComposerRoute,
});

/**
 * Issues. Signed in here, capabilities inside the screen.
 *
 * One route for both halves of the module: a resident reports and follows their
 * own reports, and whoever handles issues additionally gets the queue. Splitting
 * them would put a second destination in the navigation for the same subject,
 * and the screen already renders what this account is entitled to.
 */
const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/issues",
  beforeLoad: requireSession,
  component: IssuesRoute,
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
  requestAccountRoute,
  setupRoute,
  activateRoute,
  settingsRoute,
  pluginsRoute,
  pluginViewRoute,
  themesRoute,
  themeComposerRoute,
  issuesRoute,
  memberRegisterRoute,
  apartmentRegisterRoute,
  importRoute,
  addressBookRoute,
]);

/*
 * Every route below sits under /app: the association's own public website has
 * the root. The basepath is applied to navigation and to redirects alike, so
 * the route definitions above are written - and read - as the paths they are.
 */
export const router = createRouter({ routeTree, basepath: "/app" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
