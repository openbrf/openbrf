import { Module } from "@nestjs/common";

import { MediaModule } from "../media/media.module";
import { NewsModule } from "../news/news.module";
import { BoardPostService } from "./board-post.service";
import { FeedPurgeService } from "./feed-purge.service";
import { FeedController } from "./feed.controller";
import { FeedService } from "./feed.service";
import { GroupController } from "./group.controller";
import { GroupService } from "./group.service";
import { PostCommentService } from "./post-comment.service";
import { PostReportController } from "./post-report.controller";
import { PostReportService } from "./post-report.service";

/**
 * The feed: the audiences somebody is in, what is posted to them, the comments
 * and likes under each post, the way a group's post reaches the board, and the
 * clock that empties all of it (ADR 0026).
 *
 * It imports the media module and the news module and nothing else, and exports
 * nothing, which is worth stating rather than leaving to be read off the
 * decorator. The database client, the audit log and the queue are global
 * modules, so the three lines a feature usually needs are already there; the
 * media module is what stores a post's images and removes them again with the
 * post, and the news module is what a post written as Styrelsen is written,
 * published, scheduled and mailed through (`board-post.service.ts`). Neither
 * imports this one back: the media module's serving path asks `feed-image.ts`,
 * a plain function, whether a reader may see a post's image, and the news
 * module reaches two plain functions in `feed.service.ts` - a board post is a
 * news item, and publishing one puts it in the feed. Nothing else in the
 * product has any business reaching a post.
 * In particular nothing under `src/site` may import this module or select these
 * tables: the association's website reads no session at all, so there is nobody
 * for a post to be rendered to, and the module graph is what makes that a
 * property of the code rather than a rule somebody has to remember.
 *
 * No actions registrar either, and that is a decision rather than an omission.
 * Nothing here is a thing a connected app should be able to do: a token acting
 * as a person writing into the board's private deliberation or a neighbour's
 * group is a surface with no asked-for use. The news screen's thread keeps the
 * actions it published.
 */
@Module({
  imports: [MediaModule, NewsModule],
  controllers: [FeedController, GroupController, PostReportController],
  providers: [
    FeedService,
    BoardPostService,
    PostCommentService,
    GroupService,
    PostReportService,
    FeedPurgeService,
  ],
})
export class FeedModule {}
