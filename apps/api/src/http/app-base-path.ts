/**
 * Where the single-page application lives, under this instance's origin.
 *
 * The association's own website has the root, so everything the client router
 * owns sits below one prefix. Written once and imported by everything that has
 * to agree about it: the static serving, the website's sign-in link and the
 * absolute URLs the API puts in email.
 *
 * The client half of the same fact is Vite's `base` and the router's
 * `basepath`, which are build-time and therefore cannot read this. The two are
 * held together by the end-to-end suite rather than by the type system.
 */
export const APP_BASE_PATH = "/app";

/**
 * The application's own address under an instance origin.
 *
 * APP_URL is operator-supplied and may or may not carry a trailing slash, and
 * the application owns the exact path rather than a prefix: joining the two by
 * concatenation gives "//app" for half the instances out there, which no route
 * answers. The trailing slash is trimmed once, here, rather than at each of
 * the places that build a link into the application.
 */
export function applicationUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${APP_BASE_PATH}`;
}
