import { Section, Text } from "react-email";
import type { ReactElement } from "react";

import type { MailTemplate } from "../mail-template";
import { MAIL_COLORS, MailLayout } from "./layout";

/** One update request, as the broker who sent it is shown it. */
export interface BrokerUpdateRequestExtract {
  receivedAt: Date;
  name: string | null;
  brokerage: string | null;
  apartmentReference: string | null;
  note: string | null;
  /** When the board's confirmation answered it, or null while it is open. */
  answeredAt: Date | null;
  /** The latest day the purge deletes it, by its retention clocks. */
  deletedBy: Date;
}

export interface BrokerUpdateRequestAccessReportMailProps {
  /** The address the extract is about, and the only one it goes to. */
  email: string;
  /** Every request the association holds under it, oldest first. */
  requests: readonly BrokerUpdateRequestExtract[];
}

/**
 * What the association holds about a broker's update requests, sent to the
 * address they were sent from (GDPR art. 15).
 *
 * The broker is nobody the register holds, so the address is the only thing
 * the requests can be found by - and delivering to it is what verifies who is
 * asking: only whoever reads that mailbox reads this. A board member types the
 * address in and never sees the extract, and nothing here is joined to a
 * person the association knows, so an address two people share, or one that
 * has changed hands, attributes nothing to anybody.
 *
 * Everything the request holds is printed, as it was written, with when it
 * arrived, whether the board has answered it and the day it is deleted by. An
 * address the association holds nothing under is told so, because "nothing" is
 * an answer art. 15 asks for too. It greets nobody by name, for the reason the
 * board mailbox reply gives: the name was the broker's own typing.
 */
export const brokerUpdateRequestAccessReportMail: MailTemplate<BrokerUpdateRequestAccessReportMailProps> =
  {
    id: "broker-update-request-access-report",
    processing: "brokerUpdateRequests",

    subject: (_props, { t, brand }) =>
      t("email.brokerUpdateRequestAccessReport.subject", {
        association: brand.associationName,
      }),

    body: (props, context): ReactElement => {
      const { t, brand, formatDate } = context;
      const paragraph = {
        color: MAIL_COLORS.ink,
        fontSize: "15px",
        lineHeight: 1.55,
        margin: "0 0 16px 0",
      };
      const notGiven = t("email.brokerUpdateRequestAccessReport.notGiven");

      return (
        <MailLayout
          context={context}
          preview={t("email.brokerUpdateRequestAccessReport.subject", {
            association: brand.associationName,
          })}
          heading={t("email.brokerUpdateRequestAccessReport.heading")}
          footerNotice={t("email.brokerUpdateRequestAccessReport.footer", {
            association: brand.associationName,
          })}
        >
          <Text style={paragraph}>
            {props.requests.length === 0
              ? t("email.brokerUpdateRequestAccessReport.none", {
                  association: brand.associationName,
                  email: props.email,
                })
              : t("email.brokerUpdateRequestAccessReport.intro", {
                  association: brand.associationName,
                  email: props.email,
                  count: props.requests.length,
                })}
          </Text>

          {props.requests.map((request, index) => (
            <Section key={index} style={{ margin: "0 0 16px 0" }}>
              {/* react-email escapes each value like any other child, so
                  nothing the broker typed can become markup. */}
              <Text style={{ ...paragraph, margin: 0, whiteSpace: "pre-wrap" }}>
                {[
                  `${t("email.brokerUpdateRequestAccessReport.receivedAt")}: ${formatDate(request.receivedAt)}`,
                  `${t("email.brokerUpdateRequestAccessReport.name")}: ${request.name ?? notGiven}`,
                  `${t("email.brokerUpdateRequestAccessReport.brokerage")}: ${request.brokerage ?? notGiven}`,
                  `${t("email.brokerUpdateRequestAccessReport.apartment")}: ${request.apartmentReference ?? notGiven}`,
                  `${t("email.brokerUpdateRequestAccessReport.note")}: ${request.note ?? notGiven}`,
                  request.answeredAt === null
                    ? t("email.brokerUpdateRequestAccessReport.open")
                    : t("email.brokerUpdateRequestAccessReport.answered", {
                        answeredAt: formatDate(request.answeredAt),
                      }),
                  t("email.brokerUpdateRequestAccessReport.deletedBy", {
                    deletedBy: formatDate(request.deletedBy),
                  }),
                ].join("\n")}
              </Text>
            </Section>
          ))}

          <Text style={paragraph}>
            {t("email.brokerUpdateRequestAccessReport.purpose")}
          </Text>
        </MailLayout>
      );
    },
  };
