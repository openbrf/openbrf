import { Text } from "react-email";
import type { ReactElement } from "react";

import { applicationUrl } from "../../http/app-base-path";
import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailAction, MailLayout } from "./layout";

export interface RegisterReportObligationMailProps {
  /** Board member being notified. */
  recipientName: string;
  /**
   * Which register event the report is about, as a locale key suffix rather
   * than as a rendered word.
   *
   * The enum value travels and the message names it, so the sentence stays in
   * the recipient's own language: a kind rendered by the sender would be in
   * whichever language the board member who recorded the event reads.
   */
  kind: "GRANT" | "TRANSFER" | "TERMINATION";
  /** Address and apartment number, as the apartment register designates it. */
  designation: string;
  /** The day the statutory window opened. */
  triggeredOn: Date;
  /** The day it closes. */
  dueOn: Date;
}

/**
 * Sent to the board when a register event opens a reporting window.
 *
 * The message a two-week deadline needs: it exists, it is about this apartment,
 * and it closes on this day. Lag (2026:484) 3 kap. 10 § lets Lantmateriet order
 * a late report in under penalty of a fine, so the deadline is the content and
 * the apartment is what makes it findable.
 *
 * It carries no personal data. The register event names an acquirer or a former
 * holder, and neither is needed to act on a deadline: the board opens the queue
 * and the register is there. A name in a mailbox is a name in every mailbox the
 * message passes through, and this one goes to every seat on the board.
 */
export const registerReportObligationMail: MailTemplate<RegisterReportObligationMailProps> =
  {
    id: "register-report-obligation",

    subject: (props, { t }) =>
      t("email.registerReportObligation.subject", {
        apartment: props.designation,
      }),

    body: (props, context): ReactElement => {
      const { t, formatDate, appUrl } = context;

      return (
        <MailLayout
          context={context}
          preview={t("email.registerReportObligation.subject", {
            apartment: props.designation,
          })}
          heading={t("email.registerReportObligation.heading")}
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
            {t("email.registerReportObligation.body", {
              event: t(`email.registerReportObligation.event.${props.kind}`),
              apartment: props.designation,
              triggeredOn: formatDate(props.triggeredOn),
              dueOn: formatDate(props.dueOn),
            })}
          </Text>

          <Text
            style={{
              color: MAIL_COLORS.ink,
              fontSize: "15px",
              lineHeight: 1.55,
              margin: "0 0 8px 0",
            }}
          >
            {t("email.registerReportObligation.lateNotice")}
          </Text>

          <MailAction
            context={context}
            href={applicationUrl(appUrl)}
            label={t("email.registerReportObligation.action")}
          />
        </MailLayout>
      );
    },
  };
