import { Global, Module } from "@nestjs/common";

import { type Env, loadEnv } from "./env";
import { loadNearestEnvFile } from "./load-env-file";

/** Injection token for the validated environment. */
export const ENV = Symbol("OPENBRF_ENV");

@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => {
        loadNearestEnvFile();
        return loadEnv();
      },
    },
  ],
  exports: [ENV],
})
export class ConfigModule {}
