import { createApplication, loadBootEnv, loadPluginsAtBoot } from "./bootstrap";
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

  // Installing a plugin ends by replacing this process, which means draining
  // in-flight requests first. The coordinator needs the application to close;
  // it cannot construct one.
  app.enableShutdownHooks();
  app.get(RestartCoordinator).bind(app);

  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

void bootstrap();
