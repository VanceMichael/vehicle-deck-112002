import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Ledger, DomainError } from './lib/ledger.mjs';
import { startCollector } from './collector-server.mjs';
import { start as startSource } from './source-server.mjs';

const readFixture = async (name) => JSON.parse(await readFile(new URL(`./source-data/${name}.json`, import.meta.url), 'utf8'));

async function fixtureLedger(stage = 4) {
  const [booking, ramp, deck] = await Promise.all(['booking', 'ramp', 'deck'].map(readFixture));
  const ledger = new Ledger();
  for (const record of [...booking, ...ramp, ...deck].filter((item) => item.availableFrom <= stage)) {
    ledger.ingest(record);
  }
  return ledger;
}

test('演练来源：签收时 G36 占 D3，D5 与回卷缺口单列', async () => {
  const ledger = await fixtureLedger(3);
  const view = ledger.buildView();
  const d3 = view.slots.find((slot) => slot.layer === 'L2' && slot.slot === 'D3');
  assert.equal(d3.status, 'occupied_proven');
  assert.equal(d3.asset, 'G36');
  assert.ok(d3.reasons.includes('SIGNED_OBSERVATION'));

  const d5 = view.unknownLocations.find((item) => item.layer === 'L2' && item.slot === 'D5');
  assert.ok(d5, 'D5 未检查必须进入未知位置');
  assert.ok(view.unknownLocations.some((item) => item.kind === 'unrecoverable_ramp_sequence_gap' && item.seq === 72));
  assert.deepEqual(view.ramp.gaps[0].unrecoverableSequences, [72]);

  const handoff = ledger.getHandoff('HB2');
  assert.equal(handoff.status, 'handed_over_with_open_items');
  assert.equal(handoff.signed.seen.D3, 'G36');
  assert.deepEqual(handoff.signed.unchecked, ['D5']);
  assert.deepEqual(handoff.loadingDecision.provenEmptySlots.map((slot) => slot.slot), ['D4']);
  assert.ok(handoff.loadingDecision.unresolvedSlots.some((slot) => slot.slot === 'D5'));
  assert.equal(handoff.loadingDecision.effectiveCanContinueLoading, true);
  assert.equal(handoff.snapshot.at, '09:00');
  assert.equal(handoff.snapshot.orders.find((order) => order.order === 'OT1').legAtTime, '早11');
});

test('票务改签不能单独释放：物理未清空时 OT1 被拦住', async () => {
  const ledger = await fixtureLedger(3);
  const candidate = ledger.evaluateRelease({ leg: '午13', order: 'OT1' })[0];
  assert.equal(candidate.releaseAllowed, false);
  assert.ok(candidate.blockers.some((blocker) => blocker.code === 'REBOOK_WHILE_BOARDED'));
  assert.ok(candidate.blockers.some((blocker) => blocker.code === 'PREVIOUS_LOCATION_NOT_PROVEN_CLEAR'));
  assert.throws(
    () => ledger.createRelease({ leg: '午13', order: 'OT1', slot: { layer: 'L1', slot: 'A1' } }),
    (error) => error instanceof DomainError && error.status === 422,
  );
});

test('坡道更正推翻 HB2：冻结原结论，生成下一班差异责任，核清后才能占释放位', async () => {
  const ledger = await fixtureLedger(3);
  assert.equal(ledger.listFindings().length, 0);

  const correction = (await readFixture('ramp')).find((record) => record.record === 'ramp-4');
  ledger.ingest(correction);

  const replay = ledger.replayHandoff('HB2');
  assert.equal(replay.immutableSignedRecord.snapshot.slots.find((slot) => slot.slot === 'D3').status, 'occupied_proven');
  assert.equal(replay.overturned, true);
  assert.equal(replay.signedSlots[0].recalculatedStatusAtHandoff, 'disputed_exit_before_claim');

  const finding = ledger.listFindings()[0];
  assert.match(finding.key, /^SIGNED_LOADING_OVERTURNED_BY_EXIT:L2:D3:G36:HB2$/);
  assert.equal(finding.status, 'pending_next_shift');
  assert.equal(finding.responsibility, '下一班');
  assert.equal(finding.physicalDifference.recordKey, 'ramp-4');
  assert.deepEqual(finding.physicalDifference.assets, ['T12', 'G36']);

  let candidate = ledger.evaluateRelease({ leg: '午13', order: 'OT1' })[0];
  assert.equal(candidate.releaseAllowed, false);
  assert.ok(candidate.blockers.some((blocker) => blocker.code === 'OPEN_HANDOVER_FINDING'));
  assert.throws(
    () => ledger.createRelease({ leg: '午13', order: 'OT1', slot: { layer: 'L1', slot: 'A1' }, signedBy: 'zhao' }),
    (error) => error instanceof DomainError
      && error.status === 422
      && error.details.blockers.some((blocker) => blocker.code === 'OPEN_HANDOVER_FINDING'),
  );

  ledger.actOnFinding(finding.key, 'resolve', { resolution: 'ramp_correction_confirmed', by: 'next-officer' });
  candidate = ledger.evaluateRelease({ leg: '午13', order: 'OT1' })[0];
  assert.equal(candidate.releaseAllowed, true);
  assert.equal(candidate.transferStatus, 'valid_not_boarded');

  const release = ledger.createRelease({ leg: '午13', order: 'OT1', slot: { layer: 'L1', slot: 'A1' }, signedBy: 'zhao' });
  assert.equal(release.status, 'signed');
  assert.equal(release.slot.slot, 'A1');
});

test('交班后补录驶出会重算后续在位视图，但不篡改已冻结快照', () => {
  const ledger = new Ledger();
  ledger.ingest({ record: 'b1', kind: 'booking', payload: { order: 'O1', leg: 'L1', assets: ['T', 'R'], permission: '组合' } });
  ledger.ingest({ record: 'r1', kind: 'scan', payload: { station: 'S', seq: 1, rev: 1, cycle: 'C1', direction: '入', assets: ['T', 'R'], time: '08:00' } });
  ledger.ingest({ record: 'd1', kind: 'detach', payload: { layer: 'D1', slot: '1', tractor: 'T', trailer: 'R', time: '08:05' } });
  const handoff = ledger.createHandoff({ id: 'H1', layer: 'D1', at: '09:00', seen: { 1: 'R' } });
  assert.equal(handoff.snapshot.slots[0].status, 'occupied_proven');

  ledger.ingest({ record: 'late-exit', kind: 'scan', payload: { station: 'S', seq: 9, rev: 1, cycle: 'C9', direction: '出', assets: ['T', 'R'], time: '09:20' } });
  const view = ledger.buildView({ layer: 'D1' });
  assert.equal(view.slots[0].status, 'vacated_by_exit');
  assert.equal(view.assets.find((asset) => asset.token === 'R').rampState, 'ashore');
  assert.equal(ledger.getHandoff('H1').snapshot.slots[0].status, 'occupied_proven');
  const replay = ledger.replayHandoff('H1');
  assert.equal(replay.overturned, false);
  assert.equal(replay.currentView.slots[0].status, 'vacated_by_exit');
});

test('同一挂车被两个当前甲板记作装好时产生重复装载冲突并阻止释放', () => {
  const ledger = new Ledger();
  ledger.ingest({ record: 'b9', kind: 'booking', payload: { order: 'O9', leg: 'N', assets: ['X9'], permission: '牵引车' } });
  ledger.ingest({ record: 'h1', kind: 'signoff', payload: { id: 'HA', layer: 'L8', time: '10:00', seen: { E1: 'X9' } } });
  ledger.ingest({ record: 'h2', kind: 'signoff', payload: { id: 'HB', layer: 'L9', time: '10:05', seen: { D2: 'X9' } } });
  const view = ledger.buildView();
  assert.ok(view.disputes.some((dispute) => dispute.code === 'ASSET_RECORDED_ON_MULTIPLE_DECKS' && dispute.asset === 'X9'));
  const candidate = ledger.evaluateRelease({ leg: 'N', order: 'O9' })[0];
  assert.equal(candidate.releaseAllowed, false);
  assert.ok(candidate.blockers.some((blocker) => blocker.code === 'DUPLICATE_DECK_LOADING'));
});

test('牵引车原路退出后带另一挂车回来：按 cycle/token 关联，不串挂车位置', () => {
  const ledger = new Ledger();
  ledger.ingest({ record: 'b1', kind: 'booking', payload: { order: 'O1', leg: 'L', assets: ['T', 'R1'], permission: '组合' } });
  ledger.ingest({ record: 'b2', kind: 'booking', payload: { order: 'O2', leg: 'L', assets: ['T', 'R2'], permission: '组合' } });
  ledger.ingest({ record: 'b3', kind: 'booking', payload: { order: 'O3', leg: 'L', assets: ['T'], permission: '牵引车' } });
  ledger.ingest({ record: 'in1', kind: 'scan', payload: { station: 'S', seq: 1, cycle: 'C1', direction: '入', assets: ['T', 'R1'], time: '08:00' } });
  ledger.ingest({ record: 'drop1', kind: 'detach', payload: { layer: 'L1', slot: 'D1', tractor: 'T', trailer: 'R1', time: '08:05' } });
  ledger.ingest({ record: 'out-t', kind: 'scan', payload: { station: 'S', seq: 2, cycle: 'C2', direction: '出', assets: ['T'], time: '08:10' } });
  ledger.ingest({ record: 'in2', kind: 'scan', payload: { station: 'S', seq: 3, cycle: 'C3', direction: '入', assets: ['T', 'R2'], time: '08:30' } });
  ledger.ingest({ record: 'drop2', kind: 'detach', payload: { layer: 'L1', slot: 'D2', tractor: 'T', trailer: 'R2', time: '08:35' } });

  const view = ledger.buildView();
  assert.deepEqual(view.assets.find((a) => a.token === 'R1').location, { layer: 'L1', slot: 'D1', at: '08:05' });
  assert.deepEqual(view.assets.find((a) => a.token === 'R2').location, { layer: 'L1', slot: 'D2', at: '08:35' });
  assert.equal(view.disputes.some((d) => d.code === 'ASSET_RECORDED_ON_MULTIPLE_DECKS'), false);
  const exitPassage = view.ramp.passages.find((p) => p.cycle === 'C2');
  assert.equal(exitPassage.authorization.status, 'authorized');
  assert.deepEqual(exitPassage.authorization.orderIds, ['O3']);
});

test('车牌文本只作标签：相同车牌复用到不同 token 时不合并实物身份', () => {
  const ledger = new Ledger();
  ledger.ingest({ record: 'scan-a1', kind: 'scan', payload: { cycle: 'C1', direction: '入', assets: ['PHYS-A1'], plates: { 'PHYS-A1': 'REUSED-PLATE' }, time: '08:00' } });
  ledger.ingest({ record: 'scan-a2', kind: 'scan', payload: { cycle: 'C2', direction: '入', assets: ['PHYS-A2'], plates: { 'PHYS-A2': 'REUSED-PLATE' }, time: '08:10' } });
  const labels = ledger.getIdentityLabels();
  assert.deepEqual(labels['PHYS-A1'], ['REUSED-PLATE']);
  assert.deepEqual(labels['PHYS-A2'], ['REUSED-PLATE']);
  const view = ledger.buildView();
  assert.equal(view.assets.length, 2);
  assert.deepEqual(view.assets.map((asset) => asset.token).sort(), ['PHYS-A1', 'PHYS-A2']);
});

test('已签收释放位具有排他性', () => {
  const ledger = new Ledger();
  for (const id of ['O1', 'O2']) {
    ledger.ingest({ record: `b-${id}`, kind: 'booking', payload: { order: id, leg: 'N', assets: [`A-${id}`], permission: '牵引车' } });
    ledger.ingest({ record: `out-${id}`, kind: 'scan', payload: { station: 'S', seq: id === 'O1' ? 1 : 2, cycle: `C-${id}`, direction: '出', assets: [`A-${id}`], time: '07:00' } });
  }
  ledger.ingest({ record: 'clear-a1', kind: 'clear', payload: { layer: 'L1', slots: ['A1'], time: '08:00' } });
  ledger.createRelease({ leg: 'N', order: 'O1', slot: { layer: 'L1', slot: 'A1' }, signedBy: 'officer-1' });
  assert.throws(
    () => ledger.createRelease({ leg: 'N', order: 'O2', slot: { layer: 'L1', slot: 'A1' }, signedBy: 'officer-2' }),
    (error) => error.code === 'SLOT_SIGNED_TO_OTHER' || error.code === 'SLOT_ALREADY_ASSIGNED',
  );
});

test('HTTP 端到端：从来源分页采集到更正、差异处理和释放', async (t) => {
  const source = await startSource({ port: 0 });
  const collector = await startCollector({ port: 0, sourceUrl: source.url, allowReset: true });
  t.after(async () => {
    await new Promise((resolve) => collector.server.close(resolve));
    await new Promise((resolve) => source.server.close(resolve));
  });

  let response = await fetch(`${collector.url}/collect`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(response.status, 200);
  let result = await response.json();
  assert.equal(result.stage, 1);
  assert.equal(result.collected.reduce((sum, item) => sum + item.sourceCount, 0), 5);

  await fetch(`${source.url}/control?stage=4`, { method: 'POST' });
  response = await fetch(`${collector.url}/collect`, { method: 'POST', body: JSON.stringify({}) });
  result = await response.json();
  assert.equal(result.stage, 4);
  assert.equal(result.collected.reduce((sum, item) => sum + item.ingested, 0), 6);

  response = await fetch(`${collector.url}/handoffs/HB2/replay`);
  assert.equal(response.status, 200);
  const replay = await response.json();
  assert.equal(replay.overturned, true);
  assert.equal(replay.signedSnapshot.slots.find((slot) => slot.slot === 'D3').status, 'occupied_proven');
  assert.equal(replay.signedSlots[0].recalculatedStatusAtHandoff, 'disputed_exit_before_claim');

  const candidatesUrl = new URL('/release-candidates', collector.url);
  candidatesUrl.searchParams.set('leg', '午13');
  let candidates = await (await fetch(candidatesUrl)).json();
  assert.equal(candidates.candidates[0].releaseAllowed, false);

  response = await fetch(`${collector.url}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ leg: '午13', order: 'OT1', slot: { layer: 'L1', slot: 'A1' } }),
  });
  assert.equal(response.status, 422);
  const blocked = await response.json();
  assert.ok(blocked.details.blockers.some((item) => item.code === 'OPEN_HANDOVER_FINDING'));

  const findings = await (await fetch(`${collector.url}/findings`)).json();
  const key = findings.findings[0].key;
  response = await fetch(`${collector.url}/findings/${encodeURIComponent(key)}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resolution: 'ramp_correction_confirmed', by: 'next-shift' }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${collector.url}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ leg: '午13', order: 'OT1', slot: { layer: 'L1', slot: 'A1' }, signedBy: 'officer-zhao' }),
  });
  assert.equal(response.status, 201);
  const release = await response.json();
  assert.equal(release.status, 'signed');
  assert.equal(release.slot.slot, 'A1');

  response = await fetch(`${collector.url}/unknown`);
  const unknown = await response.json();
  assert.ok(unknown.unknownLocations.some((item) => item.slot === 'D5'));
});
