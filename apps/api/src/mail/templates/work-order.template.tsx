import { Link, Text } from "react-email";
import type { ReactElement } from "react";

import { siteUrl } from "../../http/app-base-path";
import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailLayout } from "./layout";

export interface WorkOrderMailProps {
  /** The contractor as the association's list names them. */
  recipientName: string;
  /** The work order, as the handler wrote and previewed it. */
  body: string;
  /**
   * The path of the association's privacy notice on its website, for the
   * first work order mailed to this contractor (GDPR art. 14(3)(b)), or null
   * for every later one and while the notice is not published. Decided by
   * the mailer at sending, as the heading is, and never signed with the
   * preview: it is the association's page, not the handler's words.
   */
  privacyNoticePath: string | null;
}

/**
 * A work order (arbetsorder) to a contractor, mailed while the contractor's
 * own link is switched off (decision 25 of the issue module's plan).
 *
 * The handler's text and nothing else from the issue: no report, no reporter,
 * no type, no photograph and no link into the application. A contractor has no account,
 * and everything the issue holds beyond what the handler chose to write is the
 * association's own and the reporter's (decision 23). What the handler wrote
 * they read back first, in a preview rendered by this template, so the mail
 * that leaves is the one they saw.
 *
 * The one mail whose body is free text a handler wrote about an issue, and the
 * one exception to decision 21: every other mail about an issue says only that
 * something happened and links to it, because its reader can sign in. A
 * contractor cannot, so the work order is the message; the owner made it the
 * exception on 2026-11-03 (ADR 0055, question 3). It holds as long as what
 * makes it narrow holds: the preview the server enforces, nothing else from the
 * issue, and a text with a personal identity number refused.
 *
 * The first work order to a contractor also links the association's privacy
 * notice, on its public website, which is how the association tells a sole
 * trader or a firm's contact person what it keeps about them, at the latest
 * at its first communication with them (GDPR art. 14(3)(b), ADR 0057 question
 * 6). Not a link into the application, and nothing of the issue: the same page
 * every visitor reads. A later work order does not repeat it.
 *
 * Sent under the `issues` processing, which therefore names the mail server
 * and the contractors among its recipients.
 */
export const workOrderMail: MailTemplate<WorkOrderMailProps> = {
  id: "issue-work-order",
  processing: "issues",

  subject: (_props, { t, brand }) =>
    t("email.workOrder.subject", { association: brand.associationName }),

  body: (props, context): ReactElement => {
    const { t, brand } = context;

    return (
      <MailLayout
        context={context}
        preview={t("email.workOrder.subject", {
          association: brand.associationName,
        })}
        heading={t("email.workOrder.heading")}
        recipientName={props.recipientName}
        footerNotice={t("email.workOrder.footerNotice", {
          association: brand.associationName,
        })}
      >
        {/*
         * The work order as it was written, with its own line breaks kept.
         * react-email escapes the value like any other child, so nothing in it
         * can become markup.
         */}
        <Text
          style={{
            color: MAIL_COLORS.ink,
            fontSize: "15px",
            lineHeight: 1.55,
            margin: "0 0 16px 0",
            whiteSpace: "pre-wrap",
          }}
        >
          {props.body}
        </Text>

        {props.privacyNoticePath === null ? null : (
          <Text
            style={{
              color: MAIL_COLORS.inkMuted,
              fontSize: "13px",
              lineHeight: 1.5,
              margin: "0 0 16px 0",
            }}
          >
            {t("email.workOrder.privacyNotice", {
              association: brand.associationName,
            })}{" "}
            <Link href={siteUrl(context.appUrl, props.privacyNoticePath)}>
              {siteUrl(context.appUrl, props.privacyNoticePath)}
            </Link>
          </Text>
        )}
      </MailLayout>
    );
  },
};
