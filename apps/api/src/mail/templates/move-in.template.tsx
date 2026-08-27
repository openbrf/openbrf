import { Text } from "react-email";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface MoveInMailProps {
  recipientName: string;
  apartmentNumber: string;
  movedInOn: Date;
}

/** Welcome mail triggered by the move-in flow. */
export const moveInMail: MailTemplate<MoveInMailProps> = {
  id: "move-in",

  subject: (_props, { t, brand }) =>
    t("email.moveIn.subject", { association: brand.associationName }),

  body: (props, context): ReactElement => {
    const { t, brand, formatDate, appUrl } = context;

    return (
      <MailLayout
        context={context}
        preview={t("email.moveIn.subject", {
          association: brand.associationName,
        })}
        heading={t("email.moveIn.heading")}
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
          {t("email.moveIn.body", {
            apartment: props.apartmentNumber,
            movedInOn: formatDate(props.movedInOn),
          })}
        </Text>

        <MailAction
          context={context}
          href={appUrl}
          label={t("email.moveIn.action")}
        />
      </MailLayout>
    );
  },
};
