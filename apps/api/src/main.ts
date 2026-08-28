import { createApplication, loadBootEnv, loadPluginsAtBoot } from "./bootstrap";
import { ENV } from "./config/config.module";
import type { Env } from "./config/env";
import { registerMultipart } from "./http/multipart";
import { serveSinglePageApp } from "./http/serve-single-page-app";
import { bridgeHostResolution } from "./plugins/plugin-resolution";
import { RestartCoordinator } from "./plugins/restart-coordinator.service";
import { SITE_HTML_HEADERS, SiteRenderer } from "./site/site-renderer.service";

async function bootstrap(): Promise<void> {
  // Before anything else, because an installed plugin's CommonJS bundle can
  // otherwise resolve nothing from the host: CJS resolution walks up from
  // /data/plugins and never reaches the application's node_modules (ADR 0003).
  // The loader repeats this when it runs; doing it here as well means the
  // process is in the documented state from its first line, whatever the
  // entrypoint or the dev script did or did not set.
  bridgeHostResolution();

  const env = loadBootEnv();
  const app = await createApplication(await loadPluginsAtBoot(env));

  // On the built application rather than inside createApplication, which is
  // retried once per plugin it has to drop.
  await registerMultipart(app, app.get<Env>(ENV));

  // Installing a plugin ends by replacing this process, which means draining
  // in-flight requests first, and stopping the container sends the same
  // SIGTERM: the job queue and the database connection close rather than being
  // killed with work in flight, which is what docker-compose.prod.yml allows
  // thirty seconds for. The coordinator needs the application to close; it
  // cannot construct one.
  app.enableShutdownHooks();
  app.get(RestartCoordinator).bind(app);

  // Last, because it claims every GET the API did not answer - including the
  // routes an installed plugin registered through createApplication above.
  //
  // The route that claims them answers an address the client does not own with
  // the association's own not-found page, rendered by the same code the page
  // routes use. Two renderings would eventually differ, and the difference
  // would be exactly the signal that tells an anonymous visitor a member-only
  // page exists.
  const site = app.get(SiteRenderer);
  await serveSinglePageApp(
    app,
    process.env.OPENBRF_WEB_ROOT,
    async (request, reply) => {
      const acceptLanguage = request.headers["accept-language"];
      const html = await site.notFound(
        typeof acceptLanguage === "string" ? acceptLanguage : undefined,
      );
      void reply.code(404).headers(SITE_HTML_HEADERS).send(html);
    },
  );

  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

void bootstrap();
