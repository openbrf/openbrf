import { Module } from "@nestjs/common";

import { MediaModule } from "../media/media.module";
import { BoardMailboxController } from "./board-mailbox.controller";
import { BoardMailboxService } from "./board-mailbox.service";
import { BoardMailboxCollectorService } from "./board-mailbox-collector.service";
import { BoardMailboxMailerService } from "./board-mailbox-mailer.service";
import { BoardMailboxPurgeService } from "./board-mailbox-purge.service";

/**
 * The shared board mailbox (styrelsemail): collecting the board's address into
 * this instance, working the threads it produces, and erasing them when their
 * retention runs out.
 *
 * MediaModule is imported for the attachments that arrive on a letter. The
 * database, the field encryption, the audit log, the mail path, the job queue
 * and the principal the controller reads come from the global modules, which is
 * why they are not listed here.
 *
 * The services are exported because the settings module needs the collector to
 * answer the board when the mailbox is configured, and nothing else outside this
 * folder reaches into it: no plugin surface, and above all no path from the
 * association's website, which takes no authenticated read at all.
 */
@Module({
  imports: [MediaModule],
  controllers: [BoardMailboxController],
  providers: [
    BoardMailboxService,
    BoardMailboxCollectorService,
    BoardMailboxMailerService,
    BoardMailboxPurgeService,
  ],
  exports: [BoardMailboxService, BoardMailboxCollectorService],
})
export class BoardMailboxModule {}
