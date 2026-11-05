import { Resend } from "resend";
import type { SiteEnv } from "./env";

export function createResendClient(env: SiteEnv): Resend | null {
  return env.resendApiKey ? new Resend(env.resendApiKey) : null;
}
