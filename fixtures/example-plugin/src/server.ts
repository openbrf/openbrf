import {
  BadRequestException,
  Body,
  type CanActivate,
  Controller,
  Delete,
  type DynamicModule,
  type ExecutionContext,
  Get,
  Injectable,
  Module,
  NotImplementedException,
  type OnApplicationShutdown,
  type OnModuleInit,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type {
  ActionRequest,
  PluginHost,
  PluginModuleFactory,
  PluginSettingsValues,
} from "@openbrf/plugin-sdk";
import { z } from "zod";

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

/**
 * What the host's authorization guard leaves on a request it admitted.
 *
 * Read off the request object structurally rather than imported: these are the
 * host's own fields, set on the request before the route runs, and a plugin has
 * no package to import them from. Both are optional because a plugin sees only
 * what the branch that admitted the request established - a request admitted on
 * the browser's session cookie carries a person and no connected app.
 */
interface HostRequest {
  principal?: { personId?: string };
  token?: { clientId?: string };
}

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
 * Who the host admitted, as the resource routes report it.
 *
 * The route is named in the answer so that a caller can tell which of the two
 * handlers replied: the declared route and the path beneath it are two
 * registrations, and only one of them is the one the manifest names.
 */
function seenBy(
  route: string,
  request: HostRequest,
): { route: string; personId: string | null; clientId: string | null } {
  return {
    route,
    personId: request.principal?.personId ?? null,
    clientId: request.token?.clientId ?? null,
  };
}

/** The days a resident says they are away, as they gave them. */
const awaySchema = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
});

/** Days after the last day away that the record is kept, then erased. */
const AWAY_KEPT_DAYS = 30;

/**
 * The `keepAtMostDays` the manifest declares for `away`: the host refuses an
 * erase date further from today than that.
 */
const AWAY_KEEP_AT_MOST_DAYS = 400;

/** A `YYYY-MM-DD` day moved by a number of days. */
function addDays(day: string, days: number): string {
  const moved = new Date(`${day}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/**
 * Why the days away were refused, as the reason a caller branches on and the
 * key in this plugin's namespace (`plugin-occupancy`) of the sentence the
 * person is shown, in their own language. Never the sentence itself: the
 * server does not know which language the screen speaks.
 */
type AwayRefusal = "invalid" | "past" | "tooFar" | "notListed" | "unsupported";

function refusal(reason: AwayRefusal): {
  reason: AwayRefusal;
  messageKey: string;
} {
  return { reason, messageKey: `away.refused.${reason}` };
}

function refuse(reason: AwayRefusal): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: "Bad Request",
    ...refusal(reason),
  });
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
   * Refuses a route about days away on an instance that cannot keep records
   * about a person, as the plugin contract's feature detection spells it.
   */
  function refuseWithoutStore(): void {
    if (
      host.personRecords === undefined ||
      host.addressBook.caller === undefined
    ) {
      throw new NotImplementedException({
        statusCode: 501,
        error: "Not Implemented",
        ...refusal("unsupported"),
      });
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

    /*
     * The two routes below exist for one property and nothing else.
     *
     * This manifest declares `oauthProtectedResource: "mcp"`, which makes
     * `/api/plugin/occupancy/mcp` the instance's OAuth protected resource: the
     * audience every access token is issued for, and a route that stops
     * accepting the browser's session cookie and accepts only a Bearer token
     * issued for it. So does every path beneath it, which is why there are two
     * - a connector serves an endpoint rather than a single route, and a
     * sub-path that fell through to the cookie path would be reachable with the
     * session the member's own browser already holds.
     *
     * None of that is written here. The host's guard does all of it, from the
     * manifest field alone, so what these answer with is what the guard
     * established rather than anything this bundle decided: the person the
     * credential acts for, and the connected app it was issued to. The client
     * is the half that says which branch ran, because a request admitted on a
     * session cookie carries a person and no client at all.
     */
    /*
     * The days the person on the other end says they are away: a record about
     * a person (ADR 0047), the one thing this plugin keeps about anybody.
     *
     * Who that person is comes from the host, through `addressBook.caller`,
     * never from the request body, and only a person the address book lists to
     * this plugin can keep one. The record names them as its subject and
     * carries the day the host erases it, a month after the last day away; the
     * host's purge does that, erases it on a granted request, keeps it under a
     * legal hold and puts it on the person's access report, so none of that is
     * written here.
     *
     * An instance older than the store has neither `host.personRecords` nor
     * `addressBook.caller`, whatever the SDK's types say, and ignores the
     * manifest's `personRecords`. Each route checks for both, keeps nothing
     * and says so, and never falls back to `host.records`: a record about a
     * person kept there has no erase date and is on nobody's report.
     */
    @Get("away")
    async away(@Req() request: ActionRequest): Promise<{
      listed: boolean;
      away: { from: string; to: string } | null;
    }> {
      refuseWithoutStore();
      const caller = await host.addressBook.caller(request);
      if (caller.kind !== "listed") {
        return { listed: false, away: null };
      }
      const record = await host.personRecords.get<{ from: string; to: string }>(
        "away",
        caller.resident.personId,
      );
      return { listed: true, away: record?.value ?? null };
    }

    @Put("away")
    async noteAway(
      @Req() request: ActionRequest,
      @Body() body: unknown,
    ): Promise<{ from: string; to: string; eraseOn: string }> {
      refuseWithoutStore();
      const parsed = awaySchema.safeParse(body);
      if (!parsed.success || parsed.data.to < parsed.data.from) {
        throw refuse("invalid");
      }
      // The host refuses an erase date that is not after today. Days away
      // that are already over are nothing to keep, and this leaves a margin
      // of a month for the association's calendar to differ from UTC's.
      const today = new Date().toISOString().slice(0, 10);
      if (parsed.data.to < today) {
        throw refuse("past");
      }
      // And one further from today than the collection's bound. UTC's day is
      // never ahead of the association's, so a date this lets through the
      // host accepts too. The last day is held to the bound before the month
      // is added to it: a day late in year 9999 would otherwise move into a
      // year of five digits, which no longer compares as a day does.
      const latestTo = addDays(today, AWAY_KEEP_AT_MOST_DAYS - AWAY_KEPT_DAYS);
      if (parsed.data.to > latestTo) {
        throw refuse("tooFar");
      }
      const eraseOn = addDays(parsed.data.to, AWAY_KEPT_DAYS);
      const caller = await host.addressBook.caller(request);
      if (caller.kind !== "listed") {
        // Not why: the address book does not say, and neither does this.
        throw refuse("notListed");
      }
      const subject = caller.resident.personId;
      const written = await host.personRecords.put("away", subject, {
        subject,
        eraseOn,
        value: parsed.data,
      });
      // The entry names the person it is about, so it reaches their report.
      await host.audit.record(request, { event: "away.noted", subject });
      return { ...written.value, eraseOn: written.eraseOn };
    }

    @Delete("away")
    async withdrawAway(
      @Req() request: ActionRequest,
    ): Promise<{ withdrawn: boolean }> {
      refuseWithoutStore();
      const caller = await host.addressBook.caller(request);
      if (caller.kind !== "listed") {
        return { withdrawn: false };
      }
      const subject = caller.resident.personId;
      const withdrawn = await host.personRecords.delete("away", subject);
      if (withdrawn) {
        await host.audit.record(request, { event: "away.withdrawn", subject });
      }
      return { withdrawn };
    }

    @Get("mcp")
    connector(@Req() request: HostRequest): {
      route: string;
      personId: string | null;
      clientId: string | null;
    } {
      return seenBy("mcp", request);
    }

    @Get("mcp/messages")
    connectorMessages(@Req() request: HostRequest): {
      route: string;
      personId: string | null;
      clientId: string | null;
    } {
      return seenBy("mcp/messages", request);
    }
  }

  /*
   * The action this plugin proposes.
   *
   * Registered from the module factory, which runs long before the application
   * exists - the host buffers a registration made here and flushes it once
   * there is a registry to put it in. Everything else on the host object still
   * refuses until onModuleInit, because a declaration is not work.
   *
   * What this plugin may ask for is settled in the manifest rather than here:
   * the capability, the effect, the personal-data categories and the surfaces
   * are what the board reads on the install consent screen, before any of this
   * code has been downloaded. Declaring the action does not offer it beyond the
   * instance either - an administrator arms it, per action, on the plugin's own
   * screen.
   *
   * The schemas are built with the host's zod, which the resolution bridge
   * supplies for the same reason it supplies NestJS: a second copy would
   * produce schemas from a second realm, which the host cannot convert and
   * refuses to register.
   */
  host.actions.register({
    id: "summary",
    definition: {
      name: "summary",
      titleKey: "actions.summary.title",
      descriptionKey: "actions.summary.description",
      group: "occupancy",
      groupTitleKey: "actions.group.occupancy.title",
      idempotent: true,
      additive: false,
      needsConfirmation: false,
      openWorld: false,
      errors: [],
      input: z.strictObject({}).describe("Takes no arguments."),
      output: z
        .strictObject({
          apartments: z
            .number()
            .int()
            .describe("How many apartments there are."),
          residents: z.number().int().describe("How many people live here."),
          members: z.number().int().describe("How many of them are members."),
        })
        .describe("Counts, and never a person."),
      handler: async () => host.addressBook.summary(),
    },
  });

  @Module({})
  class OccupancyModule {}

  return {
    module: OccupancyModule,
    controllers: [OccupancyController],
    providers: [OccupancyService, GroupingGuard],
  };
};
