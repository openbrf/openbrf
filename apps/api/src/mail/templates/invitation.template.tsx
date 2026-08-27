import { Text } from "@react-email/components";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface InvitationMailProps {
  recipientName: string;
  /** Absolute activation URL carrying the one-time token. */
  activationUrl: string;
  expiresAt: Date;
}

/**
 * Sent when the board creates a person and invites them to activate an
 * account. This is the only route to an account besides the first admin and an
 * approved self-signup, so it goes to residents, board members and external
 * admins alike.
 */
export const invitationMail: MailTemplate<InvitationMailProps> = {
  id: "invitation",

  subject: (_props, { t, brand }) =>
    t("email.invitation.subject", { association: brand.associationName }),

  body: (props, context): ReactElement => {
    const { t, brand, formatDate } = context;

    return (
      <MailLayout
        context={context}
        preview={t("email.invitation.subject", {
          association: brand.associationName,
        })}
        heading={t("email.invitation.heading")}
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
          {t("email.invitation.body", { association: brand.associationName })}
        </Text>

        <MailAction
          context={context}
          href={props.activationUrl}
          label={t("email.invitation.action")}
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
