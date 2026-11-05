"use client";

import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export function createSiteAuthClient(baseURL?: string) {
  return createAuthClient({
    baseURL,
    plugins: [magicLinkClient()],
  });
}

export const authClient = createSiteAuthClient();
