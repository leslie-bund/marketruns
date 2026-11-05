import React from "react";
import { Button, Text } from "react-email";
import { BrandEmailLayout, colors, textStyle } from "./components/brand-layout";

interface MagicLinkEmailProps {
  url: string;
}

export default function MagicLinkEmail({ url }: MagicLinkEmailProps) {
  return (
    <BrandEmailLayout
      title="Your Market Runs sign-in link"
      preview="Your one-time Market Runs sign-in link is ready"
      heading="Sign in to Market Runs"
    >
      <Text style={textStyle}>Use this one-time link to sign in. It expires shortly.</Text>
      <Button
        href={url}
        style={{
          backgroundColor: colors.green,
          borderRadius: "8px",
          boxSizing: "border-box",
          color: "#07130b",
          display: "inline-block",
          fontSize: "16px",
          fontWeight: 700,
          lineHeight: "24px",
          minHeight: "48px",
          padding: "12px 22px",
          textDecoration: "none",
        }}
      >
        Sign in to Market Runs
      </Button>
      <Text style={{ ...textStyle, color: colors.muted, fontSize: "14px", lineHeight: "22px", margin: "24px 0 0" }}>
        If you did not request this link, you can ignore this email.
      </Text>
    </BrandEmailLayout>
  );
}

MagicLinkEmail.PreviewProps = {
  url: "https://www.marketruns.org/sign-in",
} satisfies MagicLinkEmailProps;
