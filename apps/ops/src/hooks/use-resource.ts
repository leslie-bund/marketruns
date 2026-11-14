import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { addQuery } from "../lib/format";
import type { ListEnvelope } from "../lib/types";

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string;
  refresh: () => void;
}

export function useResource<T>(path: string | null): Resource<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({ key: "", data: null, error: "" });
  const [revision, setRevision] = useState(0);
  const key = path ? `${revision}:${path}` : "";
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const requestKey = `${revision}:${path}`;
    void fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
        if (!response.ok) throw new Error(body?.message ?? body?.error ?? `Request failed (${response.status})`);
        return body as T;
      })
      .then((body) => { if (!cancelled) setState({ key: requestKey, data: body, error: "" }); })
      .catch((reason: unknown) => {
        if (!cancelled) setState({ key: requestKey, data: null, error: reason instanceof Error ? reason.message : "Could not load this resource." });
      });
    return () => { cancelled = true; };
  }, [path, revision]);

  const loading = Boolean(path) && state.key !== key;
  return {
    data: path && !loading ? state.data : null,
    loading,
    error: path && !loading ? state.error : "",
    refresh,
  };
}

export function usePagedResource<T>(path: string, pageSize = 50) {
  const [pagination, setPagination] = useState({ path, page: 0 });
  const page = pagination.path === path ? pagination.page : 0;
  const setPage: Dispatch<SetStateAction<number>> = useCallback((value) => {
    setPagination((current) => {
      const currentPage = current.path === path ? current.page : 0;
      return { path, page: typeof value === "function" ? value(currentPage) : value };
    });
  }, [path]);
  const resource = useResource<ListEnvelope<T>>(addQuery(path, { limit: pageSize, offset: page * pageSize }));
  return { ...resource, page, setPage, pageSize };
}
