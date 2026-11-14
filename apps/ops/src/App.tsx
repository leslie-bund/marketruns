import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { RefreshCw } from "lucide-react";
import Login from "./pages/Login";
import OperationsShell from "./components/OperationsShell";
import BrandMark from "./components/BrandMark";
import { getSession, type OpsUser } from "./lib/ops-api";

const Overview = lazy(() => import("./pages/Overview"));
const RunsPage = lazy(() => import("./pages/RunsPage"));
const DisputesPage = lazy(() => import("./pages/DisputesPage"));
const SettlementsPage = lazy(() => import("./pages/SettlementsPage"));
const LedgerPage = lazy(() => import("./pages/LedgerPage"));
const PaymentsPage = lazy(() => import("./pages/PaymentsPage"));
const MarketsPage = lazy(() => import("./pages/MarketsPage"));
const StoresPage = lazy(() => import("./pages/StoresPage"));
const RunnerPoolsPage = lazy(() => import("./pages/RunnerPoolsPage"));
const ParticipantsPage = lazy(() => import("./pages/ParticipantsPage"));
const ArchivePage = lazy(() => import("./pages/ArchivePage"));
const EventsPage = lazy(() => import("./pages/EventsPage"));
const TelemetryPage = lazy(() => import("./pages/TelemetryPage"));
const AccessPage = lazy(() => import("./pages/AccessPage"));
const RolesPage = lazy(() => import("./pages/RolesPage"));

function SessionLoading() {
  return <main className="session-loading"><BrandMark /><RefreshCw className="spinning" size={20} /><span>Restoring your operator session…</span></main>;
}

export default function App() {
  const [user, setUser] = useState<OpsUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void getSession()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <SessionLoading />;
  if (!user || user.mustChangePassword) return <Login onAuthenticated={setUser} initialPasswordChange={user?.mustChangePassword ?? false} />;

  return (
    <Suspense fallback={<SessionLoading />}>
      <Routes>
        <Route element={<OperationsShell user={user} onSignedOut={() => setUser(null)} />}>
          <Route index element={<Overview />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="disputes" element={<DisputesPage />} />
          <Route path="settlements" element={<SettlementsPage />} />
          <Route path="ledger" element={<LedgerPage />} />
          <Route path="payments" element={<PaymentsPage />} />
          <Route path="markets" element={<MarketsPage />} />
          <Route path="stores" element={<StoresPage />} />
          <Route path="runner-pools" element={<RunnerPoolsPage />} />
          <Route path="participants" element={<ParticipantsPage />} />
          <Route path="archive" element={<ArchivePage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="telemetry" element={<TelemetryPage />} />
          <Route path="access" element={<AccessPage />} />
          {user.role === "admin" && <Route path="roles" element={<RolesPage />} />}
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
