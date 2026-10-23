import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import {
  PLUGIN_FINANCE_EVENTS,
  type PluginFinanceEvent,
} from "@openbrf/plugin-sdk";

import {
  type JobHandler,
  JobQueueService,
  type JobSendOptions,
  pluginQueuePrefix,
  type TransactionalSql,
} from "../jobs/job-queue.service";

/** An event as a writer states it, before the host stamps it. */
export type FinanceEventFact =
  | { type: "feeNotification.issued"; notificationId: string }
  | {
      type:
        | "memberCharge.recorded"
        | "memberCharge.corrected"
        | "memberCharge.removed";
      chargeId: string;
    };

/**
 * The queue one plugin's finance events wait on.
 *
 * Under the plugin's own `plugin/<id>/` prefix, as its own queues are, and two
 * segments deep where a name the plugin chooses is one: `host.jobs` refuses a
 * `/` in a plugin's queue name, so no queue a plugin names can be this one, and
 * no plugin can subscribe to another's.
 */
export function financeEventQueue(pluginId: string): string {
  return `${pluginQueuePrefix(pluginId)}finances/events`;
}

/**
 * Retried with a growing wait, and dropped once the retries are spent. A
 * plugin whose handler keeps throwing has a defect of its own, and the queue
 * is not the place to keep its events for good: it reads what it missed with
 * the finance reads when it is fixed.
 */
const DELIVERY: JobSendOptions = {
  retryLimit: 8,
  retryDelay: 30,
  retryBackoff: true,
};

/**
 * Finance events, from the act that caused them to the plugins listening.
 *
 * ## In the writer's transaction
 *
 * An event is enqueued by the transaction that writes the act it reports, so
 * an issue that rolled back never produces one and one that committed always
 * does. Sending after the commit has no way back when the send fails: the
 * notices are written, they are never edited, and the plugin holding the
 * approval step would simply not hear of them.
 *
 * ## One queue per plugin, and only for a plugin listening
 *
 * One job per listening plugin rather than one job fanned out by a worker of
 * core's own: a plugin whose handler throws is retried on its own queue,
 * without redelivering to the plugins that already took the event and without
 * holding them up. A plugin's queue exists from the moment it subscribes,
 * which is why only a subscribed plugin is sent to - a job sent to a queue that
 * does not exist would fail the board's own act, and no plugin may be able to
 * stop the board issuing a period's notices.
 *
 * ## Identifiers only
 *
 * An event names the run or the charge and nothing else, so it needs no
 * masking of its own and is not a second copy of anything: the plugin reads the
 * row through `host.finances`, on the same rules as every other read, and an
 * event for a row since erased leads to nothing.
 *
 * This service knows nothing about plugins beyond a queue name. Whether a
 * plugin is still serving is asked of the binding the plugin host supplies, so
 * the fees and charges modules that publish import nothing from the plugin
 * system.
 */
@Injectable()
export class FinanceEventsService {
  /** Plugin ids whose queue exists and has a worker. */
  private readonly listening = new Set<string>();
  /** Plugin ids part way through subscribing. */
  private readonly subscribing = new Set<string>();
  private serving: (pluginId: string) => boolean = () => false;

  constructor(private readonly jobs: JobQueueService) {}

  /**
   * Supplied by the plugin host binder: whether a plugin is serving now. Read
   * on every publish, so a plugin the board switched off stops receiving at
   * once, as every other host service stops answering it.
   */
  bindServing(serving: (pluginId: string) => boolean): void {
    this.serving = serving;
  }

  /**
   * Starts delivering a plugin's events to a handler.
   *
   * The queue is created here, outside any transaction, which is what lets
   * {@link publish} send to it from inside one. Once per plugin: a second
   * handler would be a second worker on the same queue, each event reaching
   * whichever of the two took it.
   */
  async listen(
    pluginId: string,
    handler: JobHandler<PluginFinanceEvent>,
  ): Promise<void> {
    if (this.listening.has(pluginId) || this.subscribing.has(pluginId)) {
      throw new Error(
        `Plugin "${pluginId}" subscribed to finance events twice; subscribe once, from onModuleInit.`,
      );
    }
    this.subscribing.add(pluginId);
    try {
      await this.jobs.work(financeEventQueue(pluginId), handler);
      this.listening.add(pluginId);
    } finally {
      this.subscribing.delete(pluginId);
    }
  }

  /**
   * Enqueues one event for every plugin listening and serving, inside the
   * writer's transaction.
   */
  async publish(tx: TransactionalSql, fact: FinanceEventFact): Promise<void> {
    const recipients = [...this.listening].filter((pluginId) =>
      this.serving(pluginId),
    );
    if (recipients.length === 0) {
      return;
    }

    const event = {
      ...fact,
      version: PLUGIN_FINANCE_EVENTS[fact.type],
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
    } as PluginFinanceEvent;

    for (const pluginId of recipients) {
      await this.jobs.sendInTransaction(
        tx,
        financeEventQueue(pluginId),
        event,
        DELIVERY,
      );
    }
  }
}
