import { Injectable } from "@nestjs/common";

import { JobQueueService } from "../jobs/job-queue.service";
import { MailService } from "../mail/mail.service";
import { SmsService } from "../sms/sms.service";
import { PluginAddressBookService } from "./plugin-address-book.service";
import { PluginHostBinding } from "./plugin-host";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * Connects the host objects the plugins already hold to the application.
 *
 * The plugins were loaded before the application existed, so each one holds an
 * object whose services are resolved on use rather than on construction. This
 * is what fills that in, and it is called once from the bootstrap between
 * `NestFactory.create` and `app.init()` - after every provider has been
 * constructed, and before any lifecycle hook or request handler can run.
 *
 * A single call site on purpose. Binding from a lifecycle hook of its own
 * would put the timing at the mercy of module ordering, and the failure that
 * produces - a plugin reading a half-built application - is exactly the one
 * the late binding exists to make impossible.
 */
@Injectable()
export class PluginHostBinder {
  constructor(
    private readonly binding: PluginHostBinding,
    private readonly registry: PluginRegistryService,
    private readonly jobs: JobQueueService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
    private readonly addressBook: PluginAddressBookService,
  ) {}

  bind(): void {
    this.binding.bind({
      registry: this.registry,
      jobs: this.jobs,
      mail: this.mail,
      sms: this.sms,
      addressBook: this.addressBook,
    });
  }
}
