import { useEffect, useRef, useState } from "react";
import { Activity, AlarmClock, Pause, Play, RadioTower, RefreshCcw, Trash2, Wifi, WifiOff } from "lucide-react";
import { CopyValue, DetailGrid, DetailRow, EmptyState, ErrorState, JsonBlock, LoadingState, PageHeader, RefreshButton, SearchField, SelectField, StatusBadge } from "../components/ops";
import { addQuery, dateTime, includesQuery, relativeTime } from "../lib/format";
import { useResource } from "../hooks/use-resource";
import type { OpsMarket, TelemetryItem } from "../lib/types";

const classes = ["MarketDO", "ProductDO", "CartDO", "RunDO", "ParticipantDO"];

export default function TelemetryPage() {
  const [objectClass, setObjectClass] = useState("");
  const [market, setMarket] = useState("");
  const [presence, setPresence] = useState("");
  const [query, setQuery] = useState("");
  const [selectedKeyState, setSelectedKey] = useState("");
  const markets = useResource<{ markets: OpsMarket[] }>("/ops/api/markets");
  const resource = useResource<{ generatedAt: number; items: TelemetryItem[] }>(addQuery("/ops/api/telemetry", { class: objectClass || undefined, market: market || undefined }));
  const items = (resource.data?.items ?? []).filter((item) => (!presence || String(item.live) === presence) && includesQuery([item.objectName, item.instanceId, item.objectClass, item.market], query));
  const selectedKey = items.some((item) => `${item.objectClass}:${item.objectName}` === selectedKeyState) ? selectedKeyState : items[0] ? `${items[0].objectClass}:${items[0].objectName}` : "";
  const selected = items.find((item) => `${item.objectClass}:${item.objectName}` === selectedKey) ?? null;
  const detail = useResource<unknown>(selected ? `/ops/api/telemetry/${encodeURIComponent(selected.objectClass)}/${encodeURIComponent(selected.objectName)}` : null);

  return <div className="page-stack">
    <PageHeader eyebrow="Live infrastructure" title="Object health & events" description="Inspect the explicit telemetry index for live Durable Objects, their connections, alarms, internal diagnostics, and bounded real-time event streams." actions={<RefreshButton loading={resource.loading} onClick={() => { resource.refresh(); detail.refresh(); }} />} />
    <div className="safeguard-note page-note"><RadioTower size={18} /><p>This page reads only objects that reported themselves into the telemetry index. It never lists a Durable Object namespace.</p></div>
    <section className="filter-bar"><SearchField value={query} onChange={setQuery} placeholder="Object, instance, class, or market" /><SelectField label="Class" value={objectClass} onChange={setObjectClass}><option value="">All classes</option>{classes.map((item) => <option key={item}>{item}</option>)}</SelectField><SelectField label="Market" value={market} onChange={setMarket}><option value="">All markets</option>{markets.data?.markets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField><SelectField label="Heartbeat" value={presence} onChange={setPresence}><option value="">Any heartbeat</option><option value="true">Live · last 45s</option><option value="false">Stale</option></SelectField></section>
    <div className="master-detail-layout">
      <section className="record-panel master-panel"><div className="panel-heading"><div><h2>Reported live instances</h2><span>{resource.data?.items.length ?? 0} indexed objects{resource.data ? ` · generated ${relativeTime(resource.data.generatedAt)}` : ""}</span></div></div>{resource.loading && <LoadingState label="Loading object heartbeats…" />}{resource.error && <ErrorState error={resource.error} onRetry={resource.refresh} />}{!resource.loading && !resource.error && items.length === 0 && <EmptyState title="No matching objects" description="Objects appear after they report a heartbeat to the explicit telemetry index." icon={<RadioTower size={24} />} />}{items.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th>Object</th><th>Class</th><th>Heartbeat</th><th>Connections</th><th>Last activity</th><th>Alarm</th></tr></thead><tbody>{items.map((item) => <tr key={`${item.objectClass}-${item.objectName}`} className={selectedKey === `${item.objectClass}:${item.objectName}` ? "selected" : ""}><td><button className="record-link" type="button" onClick={() => setSelectedKey(`${item.objectClass}:${item.objectName}`)}>{item.objectName}</button><span className="cell-subtitle">{item.market ?? "No market"} · {item.instanceId}</span></td><td><code>{item.objectClass}</code></td><td><StatusBadge status={item.live} label={item.live ? "Live" : "Stale"} /></td><td>{item.connectionCount}</td><td title={dateTime(item.lastActivityAt)}>{relativeTime(item.lastActivityAt)}</td><td>{item.alarmAt ? <span className="alarm-time"><AlarmClock size={13} />{relativeTime(item.alarmAt)}</span> : "—"}</td></tr>)}</tbody></table></div>}</section>
      <aside className="record-panel detail-panel"><div className="panel-heading"><div><p className="overline">Object diagnostics</p><h2>Telemetry inspector</h2></div>{selected && <StatusBadge status={selected.live} label={selected.live ? "Live" : "Stale"} />}</div>{!selected && <EmptyState title="Select an object" description="Choose an indexed object to inspect its diagnostics and attach an event observer." />}{selected && <div className="detail-stack"><div className="detail-title-row"><div><span className="subtle-label">{selected.objectClass}</span><CopyValue value={selected.objectName} display={selected.objectName} /></div></div><DetailGrid><DetailRow label="Instance"><CopyValue value={selected.instanceId} /></DetailRow><DetailRow label="Market">{selected.market ?? "—"}</DetailRow><DetailRow label="Connections">{selected.connectionCount}</DetailRow><DetailRow label="Last activity">{dateTime(selected.lastActivityAt)}</DetailRow><DetailRow label="Reported">{dateTime(selected.reportedAt)}</DetailRow><DetailRow label="Next alarm">{dateTime(selected.alarmAt)}</DetailRow></DetailGrid><section className="detail-section"><div className="detail-section-heading"><h3>Internal telemetry</h3>{detail.loading && <Activity size={16} className="spinning" />}</div>{detail.error && <ErrorState title="Diagnostics unavailable" error={detail.error} onRetry={detail.refresh} />}{detail.data !== null && <JsonBlock value={detail.data} />}</section><LiveObserver key={`${selected.objectClass}:${selected.objectName}`} item={selected} /></div>}</aside>
    </div>
  </div>;
}

interface ObserverEvent {
  id: number;
  receivedAt: number;
  payload: string;
}

function LiveObserver({ item }: { item: TelemetryItem }) {
  const [connectionState, setConnectionState] = useState<{ revision: number; status: "connecting" | "open" | "closed" | "error" }>({ revision: 0, status: "connecting" });
  const [events, setEvents] = useState<ObserverEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [revision, setRevision] = useState(0);
  const connection = connectionState.revision === revision ? connectionState.status : "connecting";
  const pausedRef = useRef(paused);
  const nextId = useRef(1);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ops/api/telemetry/${encodeURIComponent(item.objectClass)}/${encodeURIComponent(item.objectName)}/ws`);
    socket.onopen = () => setConnectionState({ revision, status: "open" });
    socket.onerror = () => setConnectionState({ revision, status: "error" });
    socket.onclose = () => setConnectionState((current) => current.revision === revision && current.status === "error" ? current : { revision, status: "closed" });
    socket.onmessage = (event) => {
      if (pausedRef.current) return;
      const payload = typeof event.data === "string" ? event.data : "Binary event payload";
      setEvents((current) => [{ id: nextId.current++, receivedAt: Date.now(), payload }, ...current].slice(0, 100));
    };
    return () => socket.close();
  }, [item.objectClass, item.objectName, revision]);

  return <section className="detail-section observer-panel"><div className="detail-section-heading"><div><h3>Live event observer</h3><p>Latest 100 messages · observer attachment is read-only.</p></div><StatusBadge status={connection === "open" ? "live" : connection} label={connection === "open" ? "Connected" : connection} /></div><div className="observer-actions"><button className="secondary-button compact-button" type="button" onClick={() => setPaused((value) => !value)}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? "Resume" : "Pause"}</button><button className="secondary-button compact-button" type="button" onClick={() => setRevision((value) => value + 1)}><RefreshCcw size={14} />Reconnect</button><button className="icon-button" type="button" aria-label="Clear observed events" disabled={events.length === 0} onClick={() => setEvents([])}><Trash2 size={15} /></button></div><div className="observer-status">{connection === "open" ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{paused ? "Message rendering is paused; the socket remains attached." : connection === "open" ? "Listening for live object events." : `Observer ${connection}.`}</span></div>{events.length === 0 ? <EmptyState title={paused ? "Observer paused" : "No events observed yet"} description={paused ? "Resume to render newly arriving events." : "Events appear when this object broadcasts a message to its observers."} /> : <ol className="event-stream">{events.map((event) => <li key={event.id}><time>{dateTime(event.receivedAt)}</time><pre>{formatPayload(event.payload)}</pre></li>)}</ol>}</section>;
}

function formatPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload) as unknown, null, 2);
  } catch {
    return payload;
  }
}
