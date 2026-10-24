import { Inject, Injectable } from "@nestjs/common";
import type { PluginInstanceFacts } from "@openbrf/plugin-sdk";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";

/**
 * The instance a plugin runs on, as `host.instance` reads it: the
 * association's name and the public origin.
 *
 * The select names the name and nothing else, so nothing more of the
 * association's settings reaches a plugin through here however the mapping is
 * later changed. The origin is APP_URL's, which the configuration has already
 * held to https or loopback and to carrying no path.
 */
@Injectable()
export class PluginInstanceService {
  private readonly origin: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    this.origin = new URL(env.APP_URL).origin;
  }

  async read(): Promise<PluginInstanceFacts> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { name: true },
    });
    // The settings form refuses an empty name but keeps the spaces around
    // one; a name that is only spaces is no name a screen could show.
    const name = association?.name.trim() ?? "";
    return { name: name === "" ? null : name, origin: this.origin };
  }
}
