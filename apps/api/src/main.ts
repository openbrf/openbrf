import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";

import { AppModule } from "./app.module";
import { ENV } from "./config/config.module";
import type { Env } from "./config/env";
import { registerMultipart } from "./http/multipart";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  await registerMultipart(app, app.get<Env>(ENV));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
