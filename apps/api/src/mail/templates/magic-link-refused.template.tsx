import { Text } from "react-email";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailLayout } from "./layout";

export interface MagicLinkRefusedMailProps {
  recipientName: string;
}

/**
 * Sent instead of a sign-in link when the account has TOTP enrolled.
 *
 * The refusal is explained here rather than in the HTTP response on purpose.
 * The sign-in endpoint is public, so an error saying "this account uses an
 * authenticator app" would confirm to any caller both that the address has an
 * account and that it has a second factor, turning the endpoint into an
 * enumeration oracle for a statutory register. The response is therefore the
 * same whatever the address is, and only the mailbox owner learns why no link
 * arrived.
 */
export const magicLinkRefusedMail: MailTemplate<MagicLinkRefusedMailProps> = {
  id: "magic-link-refused",

  subject: (_props, { t, brand }) =>
    t("email.magicLinkRefused.subject", { association: brand.associationName }),

  body: (props, context): ReactElement => {
    const { t, brand } = context;

    return (
      <MailLayout
        context={context}
        preview={t("email.magicLinkRefused.subject", {
          association: brand.associationName,
        })}
        heading={t("email.magicLinkRefused.heading")}
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
          {t("email.magicLinkRefused.body")}
        </Text>

        <Text
          style={{
            color: MAIL_COLORS.inkMuted,
            fontSize: "13px",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {t("email.magicLinkRefused.notRequested")}
        </Text>
      </MailLayout>
    );
  },
};
