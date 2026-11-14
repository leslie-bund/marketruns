import type { ReactNode } from "react";
import { Redirect } from "expo-router";
import { useActiveParticipant, useAuthSession } from "../api";

/** Transactional surfaces require the matching verified role and a live session. */
export function TransactionRoleGate({ role, children }: {
  role: "buyer" | "seller" | "runner";
  children: ReactNode;
}) {
  const { participant, loading } = useActiveParticipant();
  const { session, loading: sessionLoading } = useAuthSession();
  if (loading || sessionLoading) return null;
  const kycEligible = participant?.kycStatus === "verified" || participant?.kycStatus === "preverified";
  if (!participant || !session || participant.role !== role || !kycEligible) return <Redirect href="/" />;
  return children;
}
