import assert from "node:assert/strict";
import test from "node:test";
import { filterProviderRowsSince } from "./provider-baseline.mjs";

test("provider baseline excludes historical rehearsal rows and keeps new staging rows", () => {
  const rows = [
    { id: 1, created_at: "2026-11-08T18:00:00Z" },
    { id: 2, created_at: "2026-11-08T19:00:00Z" },
    { id: 3, created_at: "2026-11-08T20:00:00Z" },
  ];
  assert.deepEqual(filterProviderRowsSince(rows, "2026-11-08T19:00:00Z"), { rows: [rows[1], rows[2]], excluded: 1 });
  assert.deepEqual(filterProviderRowsSince(rows, null), { rows, excluded: 0 });
});

test("provider baseline rejects invalid timestamps and undated rows after the baseline", () => {
  assert.throws(() => filterProviderRowsSince([], "not-a-date"), /valid ISO timestamp/);
  assert.deepEqual(filterProviderRowsSince([{ id: 1 }], "2026-11-08T19:00:00Z"), { rows: [], excluded: 1 });
});
