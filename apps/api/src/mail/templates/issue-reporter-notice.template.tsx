import { Text } from "react-email";
import type { ReactElement } from "react";

import { applicationUrl } from "../../http/app-base-path";
import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface IssueReporterNoticeMailProps {
  /** The reporter, by their own name. */
  recipientName: string;
  /** The issue number (ärendenummer). */
  number: number;
  /** The type's name, as the board wrote it. */
  typeName: string;
}

/**
 * Tells a signed-in reporter that a handler wrote a new issue message on their
 * issue: the issue number, its type and a link to their own issues, and
 * nothing else (decision 21 of the issue module plan).
 *
 * Not the message: what the handler wrote stays in the instance, and the
 * reporter reads it there. Not the priority or the assignee either, which are
 * the handlers' own and which a reporter never sees (decisions 9 and 11). The
 * props carry none of it, so no later change to the body can print it.
 *
 * A reporter who filed through the website's form, with no account, is not
 * sent this: theirs is the private link of ADR 0055.
 */
export const issueReporterNoticeMail: MailTemplate<IssueReporterNoticeMailProps> =
  {
    id: "issue-reporter-notice",
    processing: "issues",

    subject: (props, { t }) =>
      t("email.issueReporterNotice.subject", {
        number: props.number,
        type: props.typeName,
      }),

    body: (props, context): ReactElement => {
      const { t, appUrl } = context;
      const values = { number: props.number, type: props.typeName };

      return (
        <MailLayout
          context={context}
          preview={t("email.issueReporterNotice.subject", values)}
          heading={t("email.issueReporterNotice.heading", values)}
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
            {t("email.issueReporterNotice.body", values)}
          </Text>

          <MailAction
            context={context}
            href={`${applicationUrl(appUrl)}/issues`}
            label={t("email.issueReporterNotice.action")}
          />
        </MailLayout>
      );
    },
  };
