import { useEffect, useState } from "react";
import { Activity, Archive, BookOpenText, ChevronRight, ClipboardList, CreditCard, FileClock, Gauge, History, KeyRound, LogOut, Map, Menu, PackageSearch, RadioTower, Scale, ShieldCheck, Store, UserCog, Users, UsersRound, X } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router";
import { signOut, type OpsUser } from "../lib/ops-api";
import BrandMark from "./BrandMark";

const groups = [
  {
    label: "Command",
    items: [
      { to: "/", label: "Overview", icon: Gauge },
      { to: "/runs", label: "Runs", icon: Activity },
      { to: "/disputes", label: "Disputes", icon: Scale },
    ],
  },
  {
    label: "Money",
    items: [
      { to: "/settlements", label: "Settlements", icon: BookOpenText },
      { to: "/ledger", label: "Ledger", icon: ClipboardList },
      { to: "/payments", label: "Payments", icon: CreditCard },
    ],
  },
  {
    label: "Network",
    items: [
      { to: "/markets", label: "Markets", icon: Map },
      { to: "/stores", label: "Stores & catalog", icon: Store },
      { to: "/runner-pools", label: "Runner pools", icon: UsersRound },
      { to: "/participants", label: "Participants", icon: Users },
    ],
  },
  {
    label: "Records",
    items: [
      { to: "/archive", label: "Archive", icon: Archive },
      { to: "/events", label: "Events & audit", icon: History },
      { to: "/telemetry", label: "Object health", icon: RadioTower },
      { to: "/access", label: "Access recovery", icon: KeyRound },
    ],
  },
  {
    label: "Administration",
    items: [
      { to: "/roles", label: "Roles & invitations", icon: UserCog, adminOnly: true },
    ],
  },
];

const pageNames: Record<string, string> = Object.fromEntries(groups.flatMap((group) => group.items.map((item) => [item.to, item.label])));

export default function OperationsShell({ user, onSignedOut }: { user: OpsUser; onSignedOut: () => void }) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  const pageName = pageNames[location.pathname] ?? "Operations";

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  const logout = async () => {
    setSigningOut(true);
    setError("");
    try {
      await signOut();
      onSignedOut();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign out.");
      setSigningOut(false);
    }
  };

  return (
    <div className="app-shell">
      {menuOpen && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar${menuOpen ? " open" : ""}`} aria-label="Operations sidebar">
        <div className="sidebar-brand"><NavLink to="/" aria-label="Market Runs operations overview" onClick={() => setMenuOpen(false)}><BrandMark small /><div><strong>Market Runs</strong><span>Operations</span></div></NavLink><button className="sidebar-close" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)}><X size={20} /></button></div>
        <nav aria-label="Operations navigation">{groups.map((group) => {
          const items = group.items.filter((item) => !("adminOnly" in item && item.adminOnly) || user.role === "admin");
          return items.length === 0 ? null : <div className="nav-group" key={group.label}><p>{group.label}</p>{items.map((item) => {
            const Icon = item.icon;
            return <NavLink key={item.to} end={item.to === "/"} className={({ isActive }) => `nav-link${isActive ? " current" : ""}`} to={item.to} onClick={() => setMenuOpen(false)}><Icon size={17} /><span>{item.label}</span><ChevronRight className="nav-chevron" size={14} /></NavLink>;
          })}</div>;
        })}</nav>
        <div className="sidebar-note"><ShieldCheck size={17} /><p>Every action is role-authorized and attributable. Money decisions stay inside settlement.</p></div>
        <div className="sidebar-operator"><div className="operator-avatar">{user.name.slice(0, 1).toUpperCase()}</div><div><strong>{user.name}</strong><span>{user.role}</span></div><button type="button" aria-label="Sign out" title="Sign out" disabled={signingOut} onClick={() => void logout()}><LogOut size={16} /></button></div>
      </aside>

      <div className="workspace-frame">
        <header className="topbar">
          <div className="topbar-location"><button className="menu-button" type="button" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={20} /></button><PackageSearch size={16} /><span>Operations</span><ChevronRight size={13} /><strong>{pageName}</strong></div>
          <div className="topbar-meta"><span className="environment-badge"><span />Staging</span><span className="topbar-email">{user.email}</span></div>
        </header>
        {error && <p className="topbar-error" role="alert">{error}</p>}
        <main className="workspace"><Outlet context={user} /></main>
        <footer className="workspace-footer"><span>Market Runs Operations</span><span><FileClock size={13} />Durable records · Live operational state</span></footer>
      </div>
    </div>
  );
}
