import {
  type CanActivate,
  Controller,
  type DynamicModule,
  type ExecutionContext,
  Get,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  Query,
  UseGuards,
} from "@nestjs/common";
import type {
  PluginHost,
  PluginModuleFactory,
  PluginSettingsValues,
} from "@openbrf/plugin-sdk";

/**
 * The reference plugin's server entry point.
 *
 * A plugin's backend is a NestJS module (ADR 0003). Everything in this file is
 * ordinary NestJS - a provider, a controller, a guard of its own and two
 * lifecycle hooks - because that is the contract rather than a demonstration
 * of it: a plugin author writes what they would write in any NestJS
 * application, and the host mounts it under the plugin's own prefix, inside
 * the application's authorization guard, at the capability floor the plugin's
 * declared permissions imply.
 *
 * `@openbrf/plugin-sdk` is imported for types only: it exists for the author's
 * build and is not resolvable from an installed plugin's directory. NestJS is
 * imported for values, which is what the resolution bridge is for - the host
 * puts its own node_modules on NODE_PATH so that this bundle resolves the one
 * running NestJS instance and not a second copy, and refuses to register the
 * plugin if it resolved anything else.
 */

/** The settings this plugin declares, narrowed from what the host stores. */
interface OccupancySettings {
  heading: string;
  showMembers: boolean;
  rowLimit: number;
  grouping: string;
}

/**
 * Fallbacks for a value the host did not supply.
 *
 * The host applies the manifest's declared defaults before handing values
 * over, so these only bite for a stored settings row written before a field
 * existed. They repeat the manifest's defaults on purpose: a plugin that
 * guesses a different value here would behave one way on a fresh install and
 * another way after an upgrade.
 */
const FALLBACK: OccupancySettings = {
  heading: "Occupancy",
  showMembers: true,
  rowLimit: 25,
  grouping: "address",
};

function readSettings(values: PluginSettingsValues): OccupancySettings {
  const heading = values.heading;
  const showMembers = values.showMembers;
  const rowLimit = values.rowLimit;
  const grouping = values.grouping;

  return {
    heading: typeof heading === "string" ? heading : FALLBACK.heading,
    showMembers:
      typeof showMembers === "boolean" ? showMembers : FALLBACK.showMembers,
    rowLimit:
      typeof rowLimit === "number" && Number.isInteger(rowLimit) && rowLimit > 0
        ? rowLimit
        : FALLBACK.rowLimit,
    grouping: typeof grouping === "string" ? grouping : FALLBACK.grouping,
  };
}

/**
 * Builds the plugin's module.
 *
 * Named `createPlugin` because that is the export the loader looks for. The
 * classes are declared inside it so each of them closes over the host object
 * this instance was given; a plugin is loaded once per process, so there is
 * nothing to be gained by hoisting them and something to lose - the host
 * object is per-plugin and carries its permissions.
 */
export const createPlugin: PluginModuleFactory = (
  host: PluginHost,
): DynamicModule => {
  /** Ordinary injectable state, constructed by NestJS. */
  @Injectable()
  class OccupancyService implements OnModuleInit, OnApplicationShutdown {
    private requests = 0;
    private configuredAtStart: string | null = null;

    /**
     * Host services are read here rather than in the constructor.
     *
     * The host object is late-bound: the application that answers it is built
     * after this module's factory has run, so it is live from onModuleInit
     * onwards. This is also where NestJS asks for start-up work in any case,
     * so the constraint costs a plugin author nothing.
     */
    async onModuleInit(): Promise<void> {
      this.configuredAtStart = readSettings(await host.settings.read()).heading;
      host.logger.info(
        `Ready with permissions: ${host.permissions.join(", ")}.`,
      );
    }

    onApplicationShutdown(): void {
      host.logger.info(`Served ${String(this.requests)} request(s).`);
    }

    /** What onModuleInit read, so a caller can see that the hook ran. */
    get startedWith(): string | null {
      return this.configuredAtStart;
    }

    async settings(): Promise<OccupancySettings> {
      this.requests += 1;
      return readSettings(await host.settings.read());
    }
  }

  /**
   * The plugin's own guard, in addition to the host's.
   *
   * Guards a plugin declares can only narrow what reaches a handler: the
   * application's authorization guard has already run, and the capability
   * floor the host raised cannot be lowered from here.
   */
  @Injectable()
  class GroupingGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<{
        query?: Record<string, unknown>;
      }>();
      const grouping = request.query?.grouping;
      return (
        grouping === undefined || grouping === "address" || grouping === "floor"
      );
    }
  }

  /**
   * The controller declares no path of its own.
   *
   * The host mounts every plugin controller under `/api/plugin/<id>/`
   * whatever it declares, so a path here would sit inside that and nothing
   * else. This one wants its routes directly under the plugin's own prefix.
   */
  @Controller()
  class OccupancyController {
    constructor(private readonly service: OccupancyService) {}

    /**
     * No capability is declared on either route.
     *
     * The host raises every plugin route to the floor its permissions imply,
     * and this plugin reads the register - so declaring one here could only
     * widen the audience below what `addressBook:read` requires.
     */
    @Get("summary")
    async summary(): Promise<{
      heading: string;
      startedWith: string | null;
      summary: unknown;
      grouping: string;
      showMembers: boolean;
      limit: number;
    }> {
      const [settings, counts] = await Promise.all([
        this.service.settings(),
        host.addressBook.summary(),
      ]);

      return {
        heading: settings.heading,
        startedWith: this.service.startedWith,
        summary: counts,
        grouping: settings.grouping,
        showMembers: settings.showMembers,
        limit: settings.rowLimit,
      };
    }

    @Get("apartments")
    @UseGuards(GroupingGuard)
    async apartments(
      @Query("grouping") grouping?: string,
    ): Promise<{ apartments: unknown[]; grouping: string }> {
      const settings = await this.service.settings();
      const rows = await host.addressBook.apartments();

      return {
        apartments: rows.slice(0, settings.rowLimit),
        grouping: grouping ?? settings.grouping,
      };
    }
  }

  @Module({})
  class OccupancyModule {}

  return {
    module: OccupancyModule,
    controllers: [OccupancyController],
    providers: [OccupancyService, GroupingGuard],
  };
};
