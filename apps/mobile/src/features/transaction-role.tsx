import type { ReactNode } from "react";
import { Redirect } from "expo-router";
import { useActiveParticipant, useAuthSession } from "../api";

/**
 * Demo exploration stays available without an account. Once a participant is
 * cached, transactional role surfaces require that exact role and a live,
 * unexpired session; pending or failed KYC never falls through to demo mode.
 */
export function TransactionRoleGate({ role, children }: {
  role: "buyer" | "seller" | "runner";
  children: ReactNode;
}) {
  const { participant, loading } = useActiveParticipant();
  const { session, loading: sessionLoading } = useAuthSession();
  if (loading || sessionLoading) return null;
  const kycEligible = participant?.kycStatus === "verified" || participant?.kycStatus === "preverified";
  if (participant && (!session || participant.role !== role || !kycEligible)) return <Redirect href="/" />;
  return children;
}
