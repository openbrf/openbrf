import { Module } from "@nestjs/common";

import { NewsAdminController } from "./news-admin.controller";
import { NewsCommentPurgeService } from "./news-comment-purge.service";
import {
  NewsCommentController,
  NewsCommentModerationController,
} from "./news-comment.controller";
import { NewsCommentService } from "./news-comment.service";
import { NewsMailerService } from "./news-mailer.service";
import { NewsReaderController } from "./news-reader.controller";
import { NewsSmsService } from "./news-sms.service";
import { NewsWriteService } from "./news-write.service";

/**
 * The association's news: writing it, publishing it, sending it to the members
 * by email and by text message, reading it inside the application, and the
 * comments the members write back.
 *
 * Deliberately not inside src/site, and that placement is the point rather than
 * a filing decision. Reaching the members means decrypting their addresses and
 * their numbers, and nothing under src/site may reach the encryption layer or
 * the registers - the
 * module graph is what makes "no stored page can reach the register" a property
 * of the code. So the half that publishes lives here, and the half the website
 * reads news through lives there, importing the database client and the block
 * parser and nothing else.
 *
 * The comments are here for a second reason on top of that one. A comment is
 * exactly as visible as the news item it sits on, and no comment is ever
 * rendered on the public website: the site takes no authenticated writes and
 * reads no session at all, so a thread there would be either anonymous or a
 * login wall on a page that promises neither. Keeping the whole of it in this
 * module rather than in src/site is what makes that a fact about the module
 * graph instead of a rule somebody has to remember.
 *
 * The database client, the audit log, the queue, the encryption layer and the
 * mail and SMS services are all global modules, which is why nothing is
 * imported here.
 */
@Module({
  controllers: [
    NewsAdminController,
    NewsReaderController,
    NewsCommentController,
    NewsCommentModerationController,
  ],
  providers: [
    NewsWriteService,
    NewsMailerService,
    NewsSmsService,
    NewsCommentService,
    NewsCommentPurgeService,
  ],
  exports: [
    NewsWriteService,
    NewsMailerService,
    NewsSmsService,
    NewsCommentService,
  ],
})
export class NewsModule {}
