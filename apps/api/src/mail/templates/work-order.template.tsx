import { Text } from "react-email";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailLayout } from "./layout";

export interface WorkOrderMailProps {
  /** The contractor as the association's list names them. */
  recipientName: string;
  /** The work order, as the handler wrote and previewed it. */
  body: string;
}

/**
 * A work order (arbetsorder) to a contractor, mailed while the contractor's
 * own link is switched off (decision 25 of the issue module's plan).
 *
 * The handler's text and nothing else: no report, no reporter, no type, no
 * photograph and no link into the application. A contractor has no account,
 * and everything the issue holds beyond what the handler chose to write is the
 * association's own and the reporter's (decision 23). What the handler wrote
 * they read back first, in a preview rendered by this template, so the mail
 * that leaves is the one they saw.
 *
 * The one mail whose body is free text a handler wrote about an issue.
 * Every other mail about an issue says only that something happened and links
 * to it (decision 21), because its reader can sign in; a contractor cannot, so
 * the work order is the message. The preview is what answers for that.
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
      </MailLayout>
    );
  },
};
