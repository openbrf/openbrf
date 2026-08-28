import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";

import { AppModule } from "./app.module";
import { serveSinglePageApp } from "./http/serve-single-page-app";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  // The job queue and the database connection close on SIGTERM rather than
  // being killed with in-flight work, which is what a container restart sends.
  app.enableShutdownHooks();
  await serveSinglePageApp(app, process.env.OPENBRF_WEB_ROOT);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
