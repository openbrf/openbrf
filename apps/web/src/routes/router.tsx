import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { authClient } from "../auth/auth-client";
import { AddressBookRoute } from "./AddressBookRoute";
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
  },
  component: SignInRoute,
});

const addressBookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    if (!(await hasSession())) {
      throw redirect({ to: "/sign-in" });
    }
  },
  component: AddressBookRoute,
});

const routeTree = rootRoute.addChildren([signInRoute, addressBookRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
