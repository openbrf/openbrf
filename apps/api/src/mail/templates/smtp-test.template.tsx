import { Text } from "react-email";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailLayout } from "./layout";

export interface SmtpTestMailProps {
  recipientName: string;
  /** Host the message was relayed through, so the arrival proves which one. */
  smtpHost: string;
}

/**
 * Sent by the SMTP settings screen to prove the configuration works.
 *
 * Its keys sit under `settings.smtp.test` rather than under `email`, because
 * this is not correspondence with a member: it is a diagnostic that the settings
 * screen emits and whose only reader is the administrator who pressed the
 * button. It still renders in the recipient's own locale, like every other
 * message this instance sends.
 */
export const smtpTestMail: MailTemplate<SmtpTestMailProps> = {
  id: "smtp-test",

  subject: (_props, { t, brand }) =>
    t("settings.smtp.test.subject", { association: brand.associationName }),

  body: (props, context): ReactElement => {
    const { t, brand } = context;

    return (
      <MailLayout
        context={context}
        preview={t("settings.smtp.test.subject", {
          association: brand.associationName,
        })}
        heading={t("settings.smtp.test.heading")}
        recipientName={props.recipientName}
      >
        <Text
          style={{
            color: MAIL_COLORS.ink,
            fontSize: "15px",
            lineHeight: 1.55,
            margin: "0 0 8px 0",
          }}
        >
          {t("settings.smtp.test.body", {
            association: brand.associationName,
            host: props.smtpHost,
          })}
        </Text>
      </MailLayout>
    );
  },
};
