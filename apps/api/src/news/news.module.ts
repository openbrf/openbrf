import { Module } from "@nestjs/common";

import { NewsAdminController } from "./news-admin.controller";
import { NewsMailerService } from "./news-mailer.service";
import { NewsWriteService } from "./news-write.service";

/**
 * The association's news: writing it, publishing it, and mailing it.
 *
 * Deliberately not inside src/site, and that placement is the point rather than
 * a filing decision. Mailing the members means decrypting their addresses, and
 * nothing under src/site may reach the encryption layer or the registers - the
 * module graph is what makes "no stored page can reach the register" a property
 * of the code. So the half that publishes lives here, and the half the website
 * reads news through lives there, importing the database client and the block
 * parser and nothing else.
 *
 * The database client, the audit log, the queue, the encryption layer and the
 * mail service are all global modules, which is why nothing is imported here.
 */
@Module({
  controllers: [NewsAdminController],
  providers: [NewsWriteService, NewsMailerService],
  exports: [NewsWriteService, NewsMailerService],
})
export class NewsModule {}
