"use strict";
// Usage logs are regional and filter completed requests by their end time.
// https://soniox.com/docs/api-reference/other/get_usage_logs
function createSonioxUsage({ url, apiKey, fetchImpl = fetch, now = () => new Date() }) {
  let cached, pending;
  async function load(at, month) {
    const byReference = new Map(), cursors = new Set();
    let cursor;
    for (let page = 0; page < 50; page++) {
      const endpoint = new URL(url);
      endpoint.searchParams.set("start_time", month + "-01T00:00:00Z");
      endpoint.searchParams.set("end_time", at.toISOString());
      endpoint.searchParams.set("limit", "1000"); endpoint.searchParams.set("sort", "end_time_asc");
      if (cursor) endpoint.searchParams.set("cursor", cursor);
      const response = await fetchImpl(endpoint, { headers: { Authorization: "Bearer " + apiKey }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Usage logs unavailable"); }
      const body = await response.json();
      if (!Array.isArray(body.usage_logs)) throw new Error("Invalid usage logs");
      for (const row of body.usage_logs) {
        const cost = typeof row.cost_usd === "string" && row.cost_usd.trim() ? Number(row.cost_usd) : row.cost_usd;
        if (!Number.isFinite(cost) || cost < 0 || (row.client_reference_id != null && typeof row.client_reference_id !== "string")) throw new Error("Invalid usage log");
        const reference = row.client_reference_id ?? "";
        const value = byReference.get(reference) || { client_reference_id: reference, cost_usd: 0, requests: 0 };
        value.cost_usd += cost; value.requests++; byReference.set(reference, value);
      }
      cursor = body.next_page_cursor;
      if (cursor == null) {
        const by_reference = [...byReference.values()].sort((a, b) => a.client_reference_id.localeCompare(b.client_reference_id));
        // Keep provider precision; the estimate endpoint alone rounds to cents.
        for (const row of by_reference) row.cost_usd = Number(row.cost_usd.toFixed(10));
        const data = { month, fetched_at: now().toISOString(), by_reference, total_usd: Number(by_reference.reduce((sum, row) => sum + row.cost_usd, 0).toFixed(10)) };
        cached = { data, at: now().getTime() }; return data;
      }
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw new Error("Invalid usage cursor");
      cursors.add(cursor);
    }
    throw new Error("Usage logs page limit exceeded");
  }
  return async () => {
    const at = now(), month = at.toISOString().slice(0, 7);
    if (cached?.data.month === month && at.getTime() - cached.at < 3600000) return cached.data;
    if (pending?.month === month) return pending.promise;
    const operation = { month, promise: load(at, month) }; pending = operation;
    try { return await operation.promise; } finally { if (pending === operation) pending = null; }
  };
}
module.exports = { createSonioxUsage };
