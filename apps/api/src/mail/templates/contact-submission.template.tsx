import { Text } from "react-email";
import type { ReactElement } from "react";

import { applicationUrl } from "../../http/app-base-path";
import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface ContactSubmissionMailProps {
  /** Board member being notified. */
  recipientName: string;
  /** What the sender called themselves, when they gave a name. */
  senderName: string | null;
  /** The address to answer to. */
  senderEmail: string;
  /** What they wrote, in full. */
  message: string;
  receivedAt: Date;
}

/**
 * Tells the board somebody has written to them through the website.
 *
 * The message travels in the email rather than only as a notice to go and
 * look, because a board reads its mail and would otherwise learn about a
 * message from a neighbour whenever somebody next opened the settings screen.
 *
 * It is a copy and never the record. The submission is stored before this is
 * enqueued, and the inbox in settings shows it whether or not this was ever
 * delivered - a mail server that is down or unconfigured must not be able to
 * lose a message somebody wrote to their housing cooperative.
 */
export const contactSubmissionMail: MailTemplate<ContactSubmissionMailProps> = {
  id: "contact-submission",

  subject: (props, { t }) =>
    t("email.contactSubmission.subject", {
      sender: props.senderName ?? props.senderEmail,
    }),

  body: (props, context): ReactElement => {
    const { t, formatDate, appUrl } = context;

    return (
      <MailLayout
        context={context}
        preview={t("email.contactSubmission.subject", {
          sender: props.senderName ?? props.senderEmail,
        })}
        heading={t("email.contactSubmission.heading")}
        recipientName={props.recipientName}
      >
        <Text
          style={{
            color: MAIL_COLORS.ink,
            fontSize: "15px",
            lineHeight: 1.55,
            margin: "0 0 16px 0",
          }}
        >
          {t("email.contactSubmission.body", {
            sender: props.senderName ?? props.senderEmail,
            email: props.senderEmail,
            receivedAt: formatDate(props.receivedAt),
          })}
        </Text>

        {/*
         * The message as it was written, with its own line breaks kept: a
         * paragraph break is part of what somebody wrote, and a wall of text is
         * a worse reading of it than they intended. react-email escapes the
         * value like any other child, so nothing in it can become markup.
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
          {props.message}
        </Text>

        <MailAction
          context={context}
          href={`${applicationUrl(appUrl)}/settings`}
          label={t("email.contactSubmission.action")}
        />
      </MailLayout>
    );
  },
};
