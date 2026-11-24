export async function collectSource(ledger, options = {}) {
  const baseUrl = options.baseUrl ?? process.env.SOURCE_URL ?? 'http://127.0.0.1:4100';
  const names = options.sources ?? ['booking', 'ramp', 'deck'];
  const limit = options.limit ?? 100;
  const fetchImpl = options.fetch ?? fetch;
  const sourceUrl = new URL(baseUrl);

  if (options.stage !== undefined && options.stage !== null) {
    const control = new URL('/control', sourceUrl);
    control.searchParams.set('stage', String(options.stage));
    const response = await fetchImpl(control, { method: 'POST' });
    if (!response.ok) throw new Error(`来源回放阶段切换失败：${response.status}`);
  }

  const summaries = new Map(names.map((name) => [name, { source: name, sourceCount: 0, ingested: 0, duplicates: 0, handoffIds: [] }]));
  const pending = [];
  let stage = null;

  for (const name of names) {
    let offset = 0;
    do {
      const url = new URL(`/source/${name}`, sourceUrl);
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('limit', String(limit));
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`采集 /source/${name} 失败：HTTP ${response.status}`);
      const body = await response.json();
      stage = body.stage ?? stage;
      for (const record of body.records ?? []) {
        summaries.get(name).sourceCount += 1;
        pending.push({ record, meta: { source: name, stage: body.stage, baseUrl: sourceUrl.origin } });
      }
      offset = body.next === null || body.next === undefined ? null : body.next;
    } while (offset !== null);
  }

  // 即使首次采集已经位于高回放阶段，也按来源首次出现阶段重放到达顺序，
  // 保证 signoff 快照不会被 availableFrom 更晚的更正预先污染。
  pending.sort((a, b) => {
    const sa = Number.isInteger(a.record.availableFrom) ? a.record.availableFrom : Number.MAX_SAFE_INTEGER;
    const sb = Number.isInteger(b.record.availableFrom) ? b.record.availableFrom : Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return String(a.record.record ?? '').localeCompare(String(b.record.record ?? ''));
  });

  for (const item of pending) {
    const result = ledger.ingest(item.record, item.meta);
    const summary = summaries.get(item.meta.source);
    if (result.duplicate) summary.duplicates += 1;
    else summary.ingested += 1;
    if (result.handoffId) summary.handoffIds.push(result.handoffId);
  }

  return { baseUrl: sourceUrl.origin, stage, collected: names.map((name) => summaries.get(name)) };
}
