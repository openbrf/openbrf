import type { ReactElement } from "react";
import { Body, Container, Head, Html, Preview, Text } from "react-email";

import type { MailTemplate } from "../mail/mail-template";
import { MAIL_COLORS, MAIL_FONT_STACK } from "../mail/templates/layout";

export interface PluginMailProps {
  /** The plugin's own subject line, already in the recipient's language. */
  subject: string;
  text: string;
  /** Optional HTML body. When absent the text is rendered as paragraphs. */
  html?: string;
  /** Shown in the footer so a recipient knows what sent this. */
  pluginId: string;
}

/**
 * A message sent by a plugin.
 *
 * Deliberately not the core MailLayout. That layout greets the recipient by
 * name and carries the association's heading structure, which is right for
 * correspondence the platform itself composes; a plugin supplies its own
 * subject and body and does not know the recipient's name, so wrapping its
 * text in a greeting would put words in the plugin's mouth.
 *
 * What it does keep is the house palette and type stack, and a footer naming
 * the plugin - so a resident who receives something unexpected can tell the
 * board which plugin to look at.
 *
 * Nothing here goes through i18next: the subject and body arrive already
 * written by the plugin, which is responsible for rendering them in the
 * recipient's language from its own merged locale files.
 */
export const pluginMail: MailTemplate<PluginMailProps> = {
  id: "plugin-message",

  subject: (props) => props.subject,

  body: (props, context): ReactElement => {
    const { brand, locale } = context;

    return (
      <Html lang={locale}>
        <Head />
        <Preview>{props.subject}</Preview>
        <Body
          style={{
            backgroundColor: MAIL_COLORS.page,
            fontFamily: MAIL_FONT_STACK,
            margin: 0,
            padding: "24px 0",
          }}
        >
          <Container
            style={{
              backgroundColor: MAIL_COLORS.surface,
              border: `1px solid ${MAIL_COLORS.line}`,
              borderRadius: "8px",
              margin: "0 auto",
              maxWidth: "560px",
              padding: "32px",
            }}
          >
            {props.html === undefined ? (
              props.text.split(/\n{2,}/).map((paragraph, index) => (
                <Text
                  // Paragraphs of a plain-text body have no identity beyond
                  // their position, and the list is rendered once and never
                  // reordered.
                  // eslint-disable-next-line react/no-array-index-key
                  key={index}
                  style={{
                    color: MAIL_COLORS.ink,
                    fontSize: "15px",
                    lineHeight: 1.55,
                    margin: "0 0 12px 0",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {paragraph}
                </Text>
              ))
            ) : (
              <div dangerouslySetInnerHTML={{ __html: props.html }} />
            )}

            <Text
              style={{
                borderTop: `1px solid ${MAIL_COLORS.line}`,
                color: MAIL_COLORS.inkMuted,
                fontSize: "12px",
                margin: "24px 0 0 0",
                paddingTop: "12px",
              }}
            >
              {`${brand.associationName} - ${props.pluginId}`}
            </Text>
          </Container>
        </Body>
      </Html>
    );
  },
};
