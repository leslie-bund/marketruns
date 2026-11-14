import { useState } from "react";
import { Pencil, Tags, Trash2 } from "lucide-react";
import ConfirmDialog from "./ConfirmDialog";
import { EmptyState, ErrorState, LoadingState, RefreshButton, StatusBadge } from "./ops";
import { moderateVocabulary } from "../lib/ops-api";
import { useResource } from "../hooks/use-resource";

interface VocabularyData {
  market: string;
  vocabulary: string[];
  stores: Array<{ name: string; storeId: string; store: string }>;
}

export default function VocabularyPanel({ market, canManage }: { market: string; canManage: boolean }) {
  const resource = useResource<VocabularyData>(`/ops/api/markets/${encodeURIComponent(market)}/vocabulary`);
  const [rename, setRename] = useState("");
  const [remove, setRemove] = useState("");
  const [to, setTo] = useState("");
  const [notice, setNotice] = useState("");

  const done = (message: string) => {
    setRename("");
    setRemove("");
    setTo("");
    setNotice(message);
    resource.refresh();
  };

  return <section className="detail-section vocabulary-panel"><div className="detail-section-heading"><div><h3>Market item vocabulary</h3><p>Shared shop-item names used to match buyer intents to stores.</p></div><RefreshButton loading={resource.loading} onClick={resource.refresh} label="Reload" /></div>{notice && <p className="action-notice" role="status">{notice}</p>}{resource.loading && <LoadingState label="Loading market vocabulary…" />}{resource.error && <ErrorState title="Vocabulary unavailable" error={resource.error} onRetry={resource.refresh} />}{resource.data && resource.data.vocabulary.length === 0 && <EmptyState title="No active vocabulary" description="Add shop items to stores in this market to build its matching vocabulary." icon={<Tags size={24} />} />}{resource.data && resource.data.vocabulary.length > 0 && <div className="vocabulary-list">{resource.data.vocabulary.map((item) => {
    const storeCount = new Set(resource.data?.stores.filter((store) => store.name === item).map((store) => store.storeId)).size;
    return <div key={item}><Tags size={15} /><div><strong>{item}</strong><span>Used by {storeCount} {storeCount === 1 ? "store" : "stores"}</span></div><StatusBadge status="active" />{canManage && <><button className="icon-button" type="button" aria-label={`Rename ${item}`} onClick={() => { setRename(item); setTo(item); }}><Pencil size={15} /></button><button className="icon-button danger-icon" type="button" aria-label={`Remove ${item}`} onClick={() => setRemove(item)}><Trash2 size={15} /></button></>}</div>;
  })}</div>}
    {rename && <ConfirmDialog title={`Rename “${rename}”?`} description={`Rename this shop item across every store in ${market}, then resynchronize the market registry.`} confirmLabel="Rename everywhere" onClose={() => setRename("")} onConfirm={async () => { if (!to.trim()) throw new Error("Enter a replacement name."); await moderateVocabulary(market, { action: "rename", from: rename, to: to.trim() }); done(`Renamed ${rename} to ${to.trim()}.`); }}><label className="dialog-field">New shared name<input autoFocus maxLength={120} value={to} onChange={(event) => setTo(event.target.value)} /></label></ConfirmDialog>}
    {remove && <ConfirmDialog destructive title={`Remove “${remove}”?`} description={`Deactivate this shop item across all stores in ${market}. Stores remain registered, but this item stops matching intents.`} confirmLabel="Remove item" onClose={() => setRemove("")} onConfirm={async () => { await moderateVocabulary(market, { action: "remove", item: remove }); done(`Removed ${remove} from active matching.`); }} />}
  </section>;
}
