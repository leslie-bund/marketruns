import { useState, type FormEvent } from "react";
import { Activity, ArrowUpRight, Search, ShieldCheck, Store, UserRound, UsersRound } from "lucide-react";
import { Link } from "react-router";
import { CopyValue, DetailGrid, DetailRow, EmptyState, ErrorState, JsonBlock, LoadingState, PageHeader, SelectField, StatusBadge } from "../components/ops";
import { addQuery, bps, titleCase } from "../lib/format";
import { useResource } from "../hooks/use-resource";
import type { ParticipantInvolvement, ParticipantProfile, Reputation } from "../lib/types";

export default function ParticipantsPage() {
  const [input, setInput] = useState("");
  const [participant, setParticipant] = useState("");
  const [role, setRole] = useState("buyer");
  const [submittedRole, setSubmittedRole] = useState("buyer");
  const resource = useResource<ParticipantInvolvement>(participant ? `/ops/api/participants/${encodeURIComponent(participant)}` : null);
  const reputation = useResource<Reputation>(participant ? addQuery("/ops/api/reputation", { participant, role: submittedRole }) : null);
  const profile = participantProfile(resource.data);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!input.trim()) return;
    setParticipant(input.trim());
    setSubmittedRole(role);
  };

  return <div className="page-stack">
    <PageHeader eyebrow="Identity & involvement" title="Participants" description="Look up one participant's onboarding state, market membership, stores, runner pools, run history, and computed operational reputation." />
    <form className="participant-search" onSubmit={submit}><label><span>Participant ID</span><div><UserRound size={18} /><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="participant:…" required /></div></label><SelectField label="Reputation role" value={role} onChange={setRole}><option value="buyer">Buyer</option><option value="seller">Seller</option><option value="runner">Runner</option></SelectField><button className="primary-button" type="submit" disabled={!input.trim()}><Search size={16} />Inspect participant</button></form>
    {!participant && <section className="record-panel"><EmptyState title="Look up a participant" description="Enter the edge-issued participant ID. This lookup never enumerates participant Durable Objects." icon={<UserRound size={24} />} /></section>}
    {participant && resource.loading && <LoadingState label="Reading participant state and durable involvements…" />}
    {participant && resource.error && <ErrorState title="Participant lookup failed" error={resource.error} onRetry={resource.refresh} />}
    {participant && resource.data && <div className="participant-layout">
      <div className="page-stack">
        <section className="record-panel participant-profile"><div className="panel-heading"><div><p className="overline">Participant profile</p><h2>{profile?.displayName ?? participant}</h2></div>{profile?.kycStatus && <StatusBadge status={profile.kycStatus} />}</div><DetailGrid><DetailRow label="Participant"><CopyValue value={participant} display={participant} /></DetailRow><DetailRow label="Role">{titleCase(profile?.role ?? submittedRole)}</DetailRow><DetailRow label="Verification">{profile?.kycStatus ? <StatusBadge status={profile.kycStatus} /> : "—"}</DetailRow><DetailRow label="Markets">{resource.data.involvements?.markets.length ? resource.data.involvements.markets.join(" · ") : "No market memberships"}</DetailRow></DetailGrid>{!profile && <div className="safeguard-note"><UserRound size={17} /><p>No live ParticipantDO profile was found. Durable involvements may still exist for this identifier.</p></div>}</section>
        <section className="record-panel"><div className="panel-heading"><div><p className="overline">Durable involvement</p><h2>Network relationships</h2></div></div><div className="involvement-grid"><div><Store size={18} /><strong>{resource.data.involvements?.stores.length ?? 0}</strong><span>Owned stores</span></div><div><UsersRound size={18} /><strong>{resource.data.involvements?.pools.length ?? 0}</strong><span>Runner pools</span></div><div><Activity size={18} /><strong>{resource.data.involvements?.runs.live.length ?? 0}</strong><span>Live runs</span></div><div><ShieldCheck size={18} /><strong>{resource.data.involvements?.runs.historical.length ?? 0}</strong><span>Historical runs</span></div></div>
          {(resource.data.involvements?.stores.length ?? 0) > 0 && <section className="detail-section"><h3>Owned stores</h3><div className="compact-record-list">{resource.data.involvements?.stores.map((store) => <Link className="compact-record" to="/stores" key={store.id}><div><strong>{store.name}</strong><span>{store.marketId}</span><ArrowUpRight size={14} /></div><p>{store.exchangePoint}</p></Link>)}</div></section>}
          {(resource.data.involvements?.pools.length ?? 0) > 0 && <section className="detail-section"><h3>Runner pool memberships</h3><div className="compact-record-list">{resource.data.involvements?.pools.map(({ pool, membership }) => <Link className="compact-record" to="/runner-pools" key={`${pool.id}-${membership.runnerId}`}><div><strong>{pool.name}</strong><StatusBadge status={membership.active} /></div><p>{pool.marketId}</p></Link>)}</div></section>}
          <details className="technical-details"><summary>Run and negotiation-room references</summary><JsonBlock value={{ runs: resource.data.involvements?.runs ?? { live: [], historical: [] }, rooms: resource.data.involvements?.rooms ?? [] }} /></details>
        </section>
      </div>
      <aside className="record-panel reputation-panel"><div className="panel-heading"><div><p className="overline">Computed standing</p><h2>Reputation</h2></div><ShieldCheck size={20} /></div><p className="panel-intro">Derived from completed runs, aborts, and dispute outcomes—never user-entered ratings.</p>{reputation.loading && <LoadingState label="Computing operational standing…" />}{reputation.error && <ErrorState title="Reputation unavailable" error={reputation.error} onRetry={reputation.refresh} />}{reputation.data && <div className="detail-stack"><div className="reputation-score"><span>Standing</span><strong>{bps(Number(reputation.data.standingBps ?? 0))}</strong><code>{Number(reputation.data.standingBps ?? 0)} bps</code></div><DetailGrid><DetailRow label="Role">{titleCase(submittedRole)}</DetailRow><DetailRow label="Completed runs">{Number(reputation.data.completedTrips ?? reputation.data.completedRuns ?? 0)}</DetailRow><DetailRow label="Aborted runs">{Number(reputation.data.abortedTrips ?? 0)}</DetailRow><DetailRow label="Disputed runs">{Number(reputation.data.disputedTrips ?? 0)}</DetailRow><DetailRow label="Abort rate">{bps(Number(reputation.data.abortRateBps ?? 0))}</DetailRow><DetailRow label="Strikes">{Number(reputation.data.strikes ?? 0)}</DetailRow></DetailGrid><details className="technical-details"><summary>Raw computation</summary><JsonBlock value={reputation.data} /></details></div>}</aside>
    </div>}
  </div>;
}

function participantProfile(data: ParticipantInvolvement | null): ParticipantProfile | null {
  const value = data?.participant;
  if (!value) return null;
  if ("participant" in value && value.participant && typeof value.participant === "object") return value.participant as ParticipantProfile;
  return value as ParticipantProfile;
}
