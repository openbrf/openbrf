import { Text } from "@react-email/components";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface MagicLinkMailProps {
  recipientName: string;
  signInUrl: string;
  expiresAt: Date;
}

/**
 * Passwordless sign-in link.
 *
 * Note the policy this supports: magic link is disabled for accounts that have
 * enrolled TOTP, because Better Auth's second factor gates password sign-in
 * only and a magic link would otherwise walk around it.
 */
export const magicLinkMail: MailTemplate<MagicLinkMailProps> = {
  id: "magic-link",

  subject: (_props, { t, brand }) =>
    t("email.magicLink.subject", { association: brand.associationName }),

  body: (props, context): ReactElement => {
    const { t, brand, formatDate } = context;

    return (
      <MailLayout
        context={context}
        preview={t("email.magicLink.subject", {
          association: brand.associationName,
        })}
        heading={t("email.magicLink.heading")}
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
          {t("email.magicLink.body")}
        </Text>

        <MailAction
          context={context}
          href={props.signInUrl}
          label={t("email.magicLink.action")}
        />

        <Text
          style={{
            color: MAIL_COLORS.inkMuted,
            fontSize: "13px",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {t("email.common.expiryNotice", {
            expiresAt: formatDate(props.expiresAt),
          })}
        </Text>
      </MailLayout>
    );
  },
};
