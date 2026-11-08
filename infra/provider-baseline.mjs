/** Filter provider rows to one deployment's explicit creation baseline. */
export function filterProviderRowsSince(rows, since) {
  if (!since) return { rows, excluded: 0 };
  const baseline = Date.parse(since);
  if (!Number.isFinite(baseline)) throw new Error("provider baseline must be a valid ISO timestamp");
  const kept = [];
  let excluded = 0;
  for (const row of rows) {
    const created = Date.parse(row.created_at ?? row.date_created ?? row.createdAt ?? "");
    if (Number.isFinite(created) && created >= baseline) kept.push(row);
    else excluded += 1;
  }
  return { rows: kept, excluded };
}
