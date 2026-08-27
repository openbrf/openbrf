import { Text } from "@react-email/components";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailLayout } from "./layout";

export interface MoveOutMailProps {
  recipientName: string;
  apartmentNumber: string;
  movedOutOn: Date;
  /** Computed from the association's retention policy. */
  purgeOn: Date;
}

/**
 * Offboarding mail triggered by the move-out flow.
 *
 * It states the two-tier retention explicitly (decision 21): the statutory
 * member register entry is kept because the law requires it, while service
 * data is erased on the purge date. Saying so unprompted is part of the
 * transparency the product is positioned on.
 */
export const moveOutMail: MailTemplate<MoveOutMailProps> = {
  id: "move-out",

  subject: (_props, { t, brand }) =>
    t("email.moveOut.subject", { association: brand.associationName }),

  body: (props, context): ReactElement => {
    const { t, brand, formatDate } = context;

    return (
      <MailLayout
        context={context}
        preview={t("email.moveOut.subject", {
          association: brand.associationName,
        })}
        heading={t("email.moveOut.heading")}
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
          {t("email.moveOut.body", {
            apartment: props.apartmentNumber,
            movedOutOn: formatDate(props.movedOutOn),
          })}
        </Text>

        <Text
          style={{
            color: MAIL_COLORS.inkMuted,
            fontSize: "13px",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {t("email.moveOut.retentionNotice", {
            purgeOn: formatDate(props.purgeOn),
          })}
        </Text>
      </MailLayout>
    );
  },
};
