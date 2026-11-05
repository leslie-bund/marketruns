import React from "react";
import { Text } from "react-email";
import { BrandEmailLayout, textStyle } from "./components/brand-layout";

interface RegistrationConfirmationEmailProps {
  name: string;
}

export default function RegistrationConfirmationEmail({ name }: RegistrationConfirmationEmailProps) {
  return (
    <BrandEmailLayout
      title="We received your Market Runs registration"
      preview="Thank you for registering your interest in Market Runs"
      heading="Registration received"
    >
      <Text style={textStyle}>Hello {name},</Text>
      <Text style={textStyle}>
        Thank you for registering your interest in Market Runs. Our team will contact you with launch and onboarding
        updates.
      </Text>
      <Text style={{ ...textStyle, marginBottom: "0" }}>Market Runs</Text>
    </BrandEmailLayout>
  );
}

RegistrationConfirmationEmail.PreviewProps = {
  name: "Ada",
} satisfies RegistrationConfirmationEmailProps;
