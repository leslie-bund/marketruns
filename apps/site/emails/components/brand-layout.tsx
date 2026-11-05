import React, { type CSSProperties, type ReactNode } from "react";
import { Body, Container, Head, Heading, Html, Link, Preview, Section, Text } from "react-email";

const colors = {
  background: "#0b0f0c",
  panel: "#111712",
  text: "#e8f0e9",
  muted: "#a7b8ab",
  green: "#4ade80",
};

const bodyStyle: CSSProperties = {
  backgroundColor: colors.background,
  color: colors.text,
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  margin: "0",
  padding: "32px 16px",
};

const containerStyle: CSSProperties = {
  backgroundColor: colors.panel,
  border: `1px solid ${colors.green}`,
  borderRadius: "12px",
  maxWidth: "560px",
  padding: "32px",
};

const textStyle: CSSProperties = {
  color: colors.text,
  fontSize: "16px",
  lineHeight: "26px",
  margin: "0 0 20px",
};

interface BrandEmailLayoutProps {
  title: string;
  preview: string;
  heading: string;
  children: ReactNode;
}

export function BrandEmailLayout({ title, preview, heading, children }: BrandEmailLayoutProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <title>{title}</title>
      </Head>
      <Body style={bodyStyle}>
        <Preview>{preview}</Preview>
        <Container lang="en" dir="ltr" style={containerStyle}>
          <Text style={{ ...textStyle, color: colors.green, fontSize: "22px", fontWeight: 700 }}>
            market·runs
          </Text>
          <Heading as="h1" style={{ color: colors.text, fontSize: "26px", lineHeight: "34px", margin: "0 0 24px" }}>
            {heading}
          </Heading>
          <Section>{children}</Section>
          <Text style={{ ...textStyle, color: colors.muted, fontSize: "14px", lineHeight: "22px", margin: "28px 0 0" }}>
            <Link href="https://www.marketruns.org" style={{ color: colors.green, textDecoration: "underline" }}>
              Visit the Market Runs website
            </Link>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export { colors, textStyle };
