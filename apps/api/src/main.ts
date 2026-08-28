import { createApplication, loadBootEnv, loadPluginsAtBoot } from "./bootstrap";
import { ENV } from "./config/config.module";
import type { Env } from "./config/env";
import { registerMultipart } from "./http/multipart";
import { serveSinglePageApp } from "./http/serve-single-page-app";
import { bridgeHostResolution } from "./plugins/plugin-resolution";
import { RestartCoordinator } from "./plugins/restart-coordinator.service";

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
  await serveSinglePageApp(app, process.env.OPENBRF_WEB_ROOT);

  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

void bootstrap();
