import { Text } from "react-email";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface IssueReporterLinkMailProps {
  /** The issue type's name, as the board wrote it. */
  typeName: string;
  /**
   * The private link: the instance's own address and the token in the path,
   * and nothing else (ADR 0055).
   */
  linkUrl: string;
}

/**
 * Gives the reporter of an issue who has no account the private link to their
 * issue (decision 20 of the issue module plan, ADR 0055).
 *
 * The type and the link, and nothing a person wrote (decision 21): not the
 * description, the location, the name the reporter gave, or any message. The
 * props carry none of it, so no later change to the body can print it.
 *
 * One address in the whole mail, the page's, and no address that does
 * anything on being opened: a mail scanner or a link preview follows every
 * link in a message, and the page writes nothing when it is read. The token is
 * in the body alone, never in the subject, where it would be in every mail
 * list and log line that shows one.
 */
export const issueReporterLinkMail: MailTemplate<IssueReporterLinkMailProps> = {
  id: "issue-reporter-link",
  processing: "issues",

  subject: (_props, { t, brand }) =>
    t("email.issueReporterLink.subject", {
      association: brand.associationName,
    }),

  body: (props, context): ReactElement => {
    const { t, brand } = context;
    const paragraph = {
      color: MAIL_COLORS.ink,
      fontSize: "15px",
      lineHeight: 1.55,
      margin: "0 0 16px 0",
    };

    return (
      <MailLayout
        context={context}
        preview={t("email.issueReporterLink.subject", {
          association: brand.associationName,
        })}
        heading={t("email.issueReporterLink.heading")}
        footerNotice={t("email.issueReporterLink.footerNotice", {
          association: brand.associationName,
        })}
      >
        <Text style={paragraph}>
          {t("email.issueReporterLink.body", { type: props.typeName })}
        </Text>

        <MailAction
          context={context}
          href={props.linkUrl}
          label={t("email.issueReporterLink.action")}
        />

        <Text
          style={{
            color: MAIL_COLORS.inkMuted,
            fontSize: "13px",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {t("email.issueReporterLink.keepPrivate")}
        </Text>
      </MailLayout>
    );
  },
};
