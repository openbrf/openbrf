import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import { Global, Module } from "@nestjs/common";

import { type Env, loadEnv } from "./env";

/** Injection token for the validated environment. */
export const ENV = Symbol("OPENBRF_ENV");

/**
 * Loads the nearest .env at or above the working directory when one exists, so
 * local development and the integration tests work without exporting
 * variables by hand. In a container the variables come from the environment
 * and no file is present.
 *
 * The search walks upward rather than resolving against this file's location,
 * because the API is consumed as CommonJS in production and as ESM under
 * Vitest, and neither __dirname nor import.meta.dirname exists in both.
 */
function loadDotEnvIfPresent(startDirectory: string = process.cwd()): void {
  const { root } = parse(startDirectory);
  let directory = startDirectory;

  for (;;) {
    const candidate = join(directory, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    if (directory === root) {
      return;
    }
    directory = dirname(directory);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => {
        loadDotEnvIfPresent();
        return loadEnv();
      },
    },
  ],
  exports: [ENV],
})
export class ConfigModule {}
