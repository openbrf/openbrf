import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactElement, ReactNode } from "react";

import type { MailTemplateContext } from "../mail-template";

/**
 * Shared shell for every email.
 *
 * The colours are literal rather than token references on purpose: mail
 * clients do not support CSS custom properties, so the theme reaches
 * correspondence only through the logo and the primary colour. The palette
 * below mirrors the default theme's light mode so mail looks like the product.
 */
const COLORS = {
  page: "#EFEDE7",
  surface: "#FFFFFF",
  ink: "#26272A",
  inkMuted: "#616269",
  line: "#DBD8CF",
} as const;

const FONT_STACK =
  "'Familjen Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif";

export interface MailLayoutProps {
  context: MailTemplateContext;
  /** Shown in the client's inbox preview line. */
  preview: string;
  heading: string;
  /** Recipient's display name, for the greeting. */
  recipientName: string;
  children: ReactNode;
}

export function MailLayout({
  context,
  preview,
  heading,
  recipientName,
  children,
}: MailLayoutProps): ReactElement {
  const { t, brand, locale } = context;

  return (
    <Html lang={locale}>
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: COLORS.page,
          fontFamily: FONT_STACK,
          margin: 0,
          padding: "24px 0",
        }}
      >
        <Container
          style={{
            backgroundColor: COLORS.surface,
            border: `1px solid ${COLORS.line}`,
            borderRadius: "8px",
            margin: "0 auto",
            maxWidth: "560px",
            padding: "32px",
          }}
        >
          {brand.logoUrl === undefined ? null : (
            <Img
              src={brand.logoUrl}
              alt={brand.associationName}
              height="40"
              style={{ marginBottom: "24px" }}
            />
          )}

          <Text
            style={{
              color: COLORS.inkMuted,
              fontSize: "13px",
              fontWeight: 600,
              letterSpacing: "0.12em",
              margin: "0 0 8px 0",
              textTransform: "uppercase",
            }}
          >
            {brand.associationName}
          </Text>

          <Text
            style={{
              color: COLORS.ink,
              fontSize: "24px",
              fontWeight: 700,
              lineHeight: 1.3,
              margin: "0 0 16px 0",
            }}
          >
            {heading}
          </Text>

          <Text
            style={{
              color: COLORS.ink,
              fontSize: "15px",
              lineHeight: 1.55,
              margin: "0 0 16px 0",
            }}
          >
            {t("email.common.greeting", { name: recipientName })}
          </Text>

          {children}

          <Hr style={{ borderColor: COLORS.line, margin: "24px 0 16px 0" }} />

          <Section>
            <Text
              style={{
                color: COLORS.inkMuted,
                fontSize: "13px",
                lineHeight: 1.5,
                margin: "0 0 4px 0",
              }}
            >
              {t("email.common.signature", {
                association: brand.associationName,
              })}
            </Text>
            <Text
              style={{
                color: COLORS.inkMuted,
                fontSize: "12px",
                lineHeight: 1.5,
                margin: 0,
              }}
            >
              {t("email.common.footerNotice", {
                association: brand.associationName,
              })}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export interface MailActionProps {
  context: MailTemplateContext;
  href: string;
  label: string;
}

/**
 * Call to action plus a copyable fallback link. The fallback is not optional:
 * button rendering is unreliable across clients, and these links are how
 * someone signs in.
 */
export function MailAction({
  context,
  href,
  label,
}: MailActionProps): ReactElement {
  const { t, brand } = context;

  return (
    <Section style={{ margin: "24px 0" }}>
      <Link
        href={href}
        style={{
          backgroundColor: brand.primaryColor,
          borderRadius: "4px",
          color: "#FFFFFF",
          display: "inline-block",
          fontSize: "14px",
          fontWeight: 600,
          padding: "12px 18px",
          textDecoration: "none",
        }}
      >
        {label}
      </Link>
      <Text
        style={{
          color: COLORS.inkMuted,
          fontSize: "12px",
          lineHeight: 1.5,
          margin: "16px 0 4px 0",
        }}
      >
        {t("email.common.linkFallback")}
      </Text>
      <Text
        style={{
          color: brand.primaryColor,
          fontSize: "12px",
          margin: 0,
          wordBreak: "break-all",
        }}
      >
        {href}
      </Text>
    </Section>
  );
}

export const MAIL_COLORS = COLORS;
export const MAIL_FONT_STACK = FONT_STACK;
