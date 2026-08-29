import { Module } from "@nestjs/common";

import { ContactSubmissionController } from "./contact.controller";
import { ContactService } from "./contact.service";

/**
 * The website's contact form, from the message arriving to the board reading
 * it.
 *
 * The service is exported because the form itself is rendered and submitted by
 * the public website, in process, rather than by a client calling this API over
 * HTTP - the same arrangement the issues module has for its public report form.
 *
 * The database, the field encryption, the mail service and the job queue all
 * come from global modules, which is why they are not listed here.
 */
@Module({
  controllers: [ContactSubmissionController],
  providers: [ContactService],
  exports: [ContactService],
})
export class ContactModule {}
