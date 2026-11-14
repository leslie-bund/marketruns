import { useState } from "react";
import { KeyRound, Plus, ShieldCheck, UserPlus } from "lucide-react";
import ConfirmDialog from "../components/ConfirmDialog";
import { ActionNotice, EmptyState, ErrorState, LoadingState, PageHeader, RefreshButton, SearchField, StatusBadge } from "../components/ops";
import { dateTime, includesQuery } from "../lib/format";
import { inviteOpsUser, revokeOpsUserSessions, setOpsUserRole, type OpsAccount } from "../lib/ops-api";
import { useOpsUser } from "../lib/ops-context";
import { useResource } from "../hooks/use-resource";
import type { OpsUser } from "../lib/ops-api";

export default function RolesPage() {
  const current = useOpsUser();
  const resource = useResource<{ users: OpsAccount[]; total: number }>("/ops/auth/admin/list-users?limit=200&sortBy=createdAt&sortDirection=asc");
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState<OpsAccount | null>(null);
  const [pendingId, setPendingId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const users = (resource.data?.users ?? []).filter((account) => includesQuery([account.name, account.email, account.role], query));

  const changeRole = async (account: OpsAccount, role: OpsUser["role"]) => {
    setPendingId(account.id);
    setError("");
    setNotice("");
    try {
      await setOpsUserRole(account.id, role);
      setNotice(`${account.name} is now ${role}.`);
      resource.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not change the operator role.");
    } finally {
      setPendingId("");
    }
  };

  return <div className="page-stack">
    <PageHeader eyebrow="Operator administration" title="Roles & invitations" description="Invite operations users, assign their access level, and revoke live sessions through Better Auth's admin plugin." actions={<><button className="primary-button" type="button" onClick={() => setInviting(true)}><Plus size={16} />Invite operator</button><RefreshButton loading={resource.loading} onClick={resource.refresh} /></>} />
    <div className="safeguard-note page-note"><ShieldCheck size={18} /><p>Viewers read operational data, operators manage network records, and admins additionally control money recovery, market configuration, and operator access.</p></div>
    <ActionNotice message={notice} /><ActionNotice message={error} error />
    <section className="filter-bar"><SearchField value={query} onChange={setQuery} placeholder="Name, email, or role" /></section>
    <section className="record-panel"><div className="panel-heading"><div><h2>Operator accounts</h2><span>{resource.data?.total ?? 0} users</span></div></div>
      {resource.loading && <LoadingState label="Loading operator accounts…" />}
      {resource.error && <ErrorState title="Role management unavailable" error={resource.error} onRetry={resource.refresh} />}
      {!resource.loading && !resource.error && users.length === 0 && <EmptyState title="No operators found" description="Invite an operations user or change the current filter." icon={<UserPlus size={24} />} />}
      {users.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th>Operator</th><th>Role</th><th>Email</th><th>Joined</th><th>Sessions</th></tr></thead><tbody>{users.map((account) => <tr key={account.id}><td><strong>{account.name}</strong><span className="cell-subtitle">{account.id}{account.id === current.id ? " · You" : ""}</span></td><td><select aria-label={`Role for ${account.name}`} value={account.role} disabled={pendingId === account.id || account.id === current.id} onChange={(event) => void changeRole(account, event.target.value as OpsUser["role"])}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select></td><td><StatusBadge status={account.emailVerified ? "verified" : "pending"} label={account.emailVerified ? "Verified" : "Invitation pending"} /><span className="cell-subtitle">{account.email}</span></td><td>{dateTime(account.createdAt)}</td><td><button className="secondary-button compact-button" type="button" disabled={account.id === current.id} onClick={() => setRevoking(account)}><KeyRound size={14} />Revoke sessions</button></td></tr>)}</tbody></table></div>}
    </section>
    {inviting && <InviteDialog onClose={() => setInviting(false)} onInvited={(email) => { setInviting(false); setNotice(`Invitation sent to ${email}.`); resource.refresh(); }} />}
    {revoking && <ConfirmDialog destructive title={`Revoke ${revoking.name}'s sessions?`} description="Every current session for this operator will end. Their account and assigned role remain unchanged." confirmLabel="Revoke sessions" onClose={() => setRevoking(null)} onConfirm={async () => { await revokeOpsUserSessions(revoking.id); setNotice(`Revoked sessions for ${revoking.name}.`); setRevoking(null); }} />}
  </div>;
}

function InviteDialog({ onClose, onInvited }: { onClose: () => void; onInvited: (email: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OpsUser["role"]>("viewer");
  return <ConfirmDialog title="Invite an operations user" description="Better Auth creates the account without a password and sends a magic link. Only an existing invited address can redeem it." confirmLabel="Create account & send invitation" onClose={onClose} onConfirm={async () => { const normalized = email.trim().toLowerCase(); if (!name.trim() || !normalized) throw new Error("Name and email are required."); await inviteOpsUser({ name: name.trim(), email: normalized, role }); onInvited(normalized); }}><div className="form-stack"><label>Name<input autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label><label>Email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Initial role<select value={role} onChange={(event) => setRole(event.target.value as OpsUser["role"])}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select></label></div></ConfirmDialog>;
}
