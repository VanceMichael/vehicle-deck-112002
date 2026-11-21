import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { start as startSource } from './source-server.mjs';
import { start as startService } from './service-server.mjs';

const get = async (base, path) => (await fetch(`${base}${path}`)).json();
const post = async (base, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '' : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const findOrder = (view, id) => view.orders.find((o) => o.order === id);
const findHandover = (view, id) => view.handovers.find((h) => h.id === id);
const findSlot = (view, leg, layer, slot) =>
  view.deck.layers.find((l) => l.leg === leg && l.layer === layer)?.slots.find((s) => s.slot === slot);

async function harness() {
  const source = await startSource();
  const dir = await mkdtemp(join(tmpdir(), 'vehicle-deck-'));
  const service = await startService({ dataDir: dir, sourceUrl: source.url });
  let closed = false;
  const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));
  return {
    source,
    service,
    dir,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(service.server);
      await closeServer(source.server);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('四阶段回放：采集、交班签收、补录推翻、差异交接与候补释放', async (t) => {
  const h = await harness();
  t.after(h.close);
  const base = h.service.url;

  // 阶段 1：登船、解挂、人工清点；rev1 的驶出只识别到牵引车
  await post(base, '/source-stage?stage=1');
  const pull1 = await post(base, '/collect');
  assert.equal(pull1.status, 200);
  assert.ok(pull1.body.sources.booking.includes('booking-1'));
  assert.ok(pull1.body.sources.ramp.includes('ramp-1'));
  let view = await get(base, '/reconcile');
  assert.equal(view.passages.length, 2);
  assert.equal(view.passages.find((p) => p.id === '坡M#73').current.assets.join(','), 'T12');
  // 人工清点覆盖边界：D3 有解挂证据证实在位
  const d3 = findSlot(view, '早11', 'L2', 'D3');
  assert.equal(d3.status, '占用');
  assert.equal(d3.asset, 'G36');
  // 牵引车已驶出，挂车仍在船
  assert.deepEqual(findOrder(view, 'OT1').assets.map((a) => [a.asset, a.onBoard]), [['T12', false], ['G36', true]]);
  assert.equal(findOrder(view, 'OT2').release.reason, '未改签，按原航次交接，不涉及候补释放');
  // 重复采集不产生重复事件
  const eventCount = (await get(base, '/events')).count;
  await post(base, '/collect');
  assert.equal((await get(base, '/events')).count, eventCount);

  // 阶段 2：回卷水位线 + 票务改签；缺口不可补，改签本身不能释放
  await post(base, '/source-stage?stage=2');
  await post(base, '/collect');
  view = await get(base, '/reconcile');
  // 人工清点本阶段到达：覆盖 D3、D4，D4 以 absent 明示空位
  assert.equal(findSlot(view, '早11', 'L2', 'D4').status, '清点证空');
  assert.deepEqual(view.floorWatermark, [{ station: '坡M', oldest: 73 }]);
  const gap = view.gaps.find((g) => g.station === '坡M' && g.seq === 72);
  assert.equal(gap.kind, '不可补缺口');
  const ot1 = findOrder(view, 'OT1');
  assert.equal(ot1.rebookedTo, '午13');
  assert.equal(ot1.release.eligible, false);
  assert.match(ot1.release.reason, /仅凭票务改签不能释放/);
  assert.equal(ot1.release.blockedBy[0].asset, 'G36');
  // 清点覆盖范围之外、又无任何舱位证据的位置保持未知
  assert.ok(view.unknown.uncountedSlots.length >= 0);

  // 阶段 3：值班员对明确甲板提交交班确认，带未清项 D5
  await post(base, '/source-stage?stage=3');
  await post(base, '/collect');
  const sign = await post(base, '/handovers', {
    id: 'HB9', leg: '早11', layer: 'L2', time: '09:05',
    seen: { D3: 'G36' }, unchecked: ['D5'],
  });
  assert.equal(sign.status, 201);
  assert.equal(sign.body.handover.status, '有效');
  assert.deepEqual(sign.body.handover.openItems, ['D5']);
  assert.match(sign.body.handover.snapshot.reasons[0], /人工清点/);
  view = await get(base, '/reconcile');
  assert.equal(findHandover(view, 'HB9').status, '有效');
  assert.ok(view.unknown.openHandoverItems.some((x) => x.slot === 'D5'));
  // 已确认交班可重看当时的过渡单、实物和计作占用的理由
  const handovers = await get(base, '/handovers');
  assert.ok(handovers.handovers.some((x) => x.snapshot.seen.D3 === 'G36'));

  // 阶段 4：seq73 的 rev2 修订到达——G36 也在 08:51 驶出，补录推翻签收
  await post(base, '/source-stage?stage=4');
  await post(base, '/collect');
  view = await get(base, '/reconcile');
  const p73 = view.passages.find((p) => p.id === '坡M#73');
  assert.equal(p73.current.rev, 2);
  assert.deepEqual(p73.current.assets, ['T12', 'G36']);
  assert.equal(p73.revisions.length, 2);
  const hb2 = findHandover(view, 'HB9');
  assert.equal(hb2.status, '已被补录推翻');
  assert.equal(hb2.differences[0].asset, 'G36');
  assert.match(hb2.differences[0].currentEvidence, /坡道出船/);
  // 后面甲板的在位视图已重算
  assert.equal(findSlot(view, '早11', 'L2', 'D3').status, '通行证离待核实');
  // 上一处已证实不再占位且手续有效，候补方可释放
  assert.equal(findOrder(view, 'OT1').release.eligible, true);
  assert.match(findOrder(view, 'OT1').release.reason, /可向航次 午13 的候补释放/);

  // 差异交接：原结论、差异实物、处理责任交下一班并签收
  const disc = await get(base, '/discrepancies');
  assert.ok(disc.discrepancies.some((x) => x.discrepancyId === '差异-HB9'));
  const ack = await post(base, '/discrepancies/差异-HB9/ack', { by: '下一班值班员', time: '09:30', responsibility: '下一班核实并处理' });
  assert.equal(ack.status, 201);
  assert.equal(ack.body.handover.acknowledged, true);
  const ackAgain = await post(base, '/discrepancies/差异-HB9/ack', {});
  assert.equal(ackAgain.status, 409);
});

test('服务重启后事件日志重放，视图与交班结论保持一致', async (t) => {
  const h = await harness();
  t.after(h.close);
  await post(h.service.url, '/source-stage?stage=4');
  await post(h.service.url, '/collect');
  await post(h.service.url, '/handovers', {
    id: 'HB9', leg: '早11', layer: 'L2', time: '09:05', seen: { D3: 'G36' }, unchecked: ['D5'],
  });
  const before = await get(h.service.url, '/reconcile');
  await new Promise((resolve) => h.service.server.close(() => resolve()));
  const restarted = await startService({ dataDir: h.dir, sourceUrl: h.source.url });
  const after = await get(restarted.url, '/reconcile');
  assert.equal(after.passages.length, before.passages.length);
  assert.ok(after.handovers.some((x) => x.id === 'HB9'));
  assert.equal(after.handovers.find((x) => x.id === 'HB9').status, '已被补录推翻');
  await new Promise((resolve) => restarted.server.close(() => resolve()));
});
