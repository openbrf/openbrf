import { Module } from "@nestjs/common";

import { PluginsModule } from "../plugins/plugins.module";
import { SupportModule } from "../support/support.module";
import { ManagementListener } from "./management-listener";
import { ManagementSummaryService } from "./management-summary.service";

/**
 * The management API (ADR 0021): the listener whoever hosts the instance reads
 * counts about it through and asks for a support session's sign-in link on
 * (ADR 0028), and the service that builds the counts.
 *
 * Not global, and it exports nothing. A plugin contributes a module into the
 * application's injector, and nothing it can resolve by token reaches the
 * summary or the listener: the plugin seal's classification of the global
 * modules' exports (scripts/check-plugin-injections.mjs) is untouched, and no
 * action, connected app or plugin can read the document. main.ts takes the
 * listener from the application to start it, which is the one way in.
 *
 * PluginsModule for the loader, whose findings the summary counts, and
 * SupportModule for the sign-in links.
 */
@Module({
  imports: [PluginsModule, SupportModule],
  providers: [ManagementSummaryService, ManagementListener],
})
export class ManagementModule {}
