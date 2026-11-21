import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derive } from './reconcile.mjs';

let n = 0;
const ev = (kind, payload, time = payload.time) => ({
  key: `t-${(n += 1)}`,
  source: 'test',
  kind,
  time: time ?? null,
  station: payload.station ?? null,
  seq: payload.seq ?? null,
  rev: payload.rev ?? null,
  payload,
});
const scan = (station, seq, direction, assets, time, rev = 1, extra = {}) =>
  ev('scan', { station, seq, rev, cycle: `C${seq}`, direction, assets, leg: 'L0', time, ...extra }, time);
const booking = (order, assets, permission, leg = 'L0') => ev('booking', { order, leg, assets, permission });
const rebook = (order, leg, time) => ev('rebook', { order, leg, time }, time);
const detach = (leg, layer, slot, tractor, trailer, time) =>
  ev('detach', { leg, layer, slot, tractor, trailer, time }, time);
const clear = (leg, layer, slots, time) => ev('clear', { leg, layer, slots, time }, time);
const count = (leg, layer, time, covered, present, absent = []) =>
  ev('count', { leg, layer, time, covered, present, absent }, time);
const signoff = (id, leg, layer, time, seen, unchecked = []) =>
  ev('signoff', { id, leg, layer, time, seen, unchecked }, time);
const floor = (station, oldest) => ev('floor', { station, oldest });

test('同一挂车在两个当前甲板都记作已装好时产生冲突', () => {
  const view = derive([
    booking('O1', ['T1', 'G1'], '组合'),
    scan('坡A', 1, '入', ['T1', 'G1'], '08:00'),
    detach('L0', 'L1', 'A1', 'T1', 'G1', '08:10'),
    detach('L0', 'L2', 'B1', 'T1', 'G1', '08:20'),
  ]);
  assert.ok(view.conflicts.some((c) => c.kind === '同一实物重复装载' && c.asset === 'G1'));
});

test('未核清车辆不能占用已签收的释放位置', () => {
  const view = derive([
    clear('L0', 'L1', ['A1'], '08:00'),
    signoff('HB9', 'L0', 'L1', '08:30', { A1: 'G9' }),
  ]);
  const slot = view.deck.layers.flatMap((l) => l.slots).find((s) => s.slot === 'A1');
  assert.equal(slot.status, '签收主张与已核实结论冲突');
  assert.ok(view.conflicts.some((c) => c.kind === '未核清占用释放位置' && c.asset === 'G9'));
  // 有独立证据的重新占用不算冲突
  const clean = derive([
    clear('L0', 'L1', ['A1'], '08:00'),
    booking('O2', ['T2', 'G2'], '组合'),
    scan('坡A', 2, '入', ['T2', 'G2'], '08:10'),
    detach('L0', 'L1', 'A1', 'T2', 'G2', '08:20'),
  ]);
  assert.equal(clean.conflicts.some((c) => c.kind === '未核清占用释放位置'), false);
});

test('组合授权缺挂、牵引车授权带挂都算手续异常，且会阻断候补释放', () => {
  const badCombo = derive([
    booking('O1', ['T1', 'G1'], '组合'),
    rebook('O1', 'L1', '09:00'),
    scan('坡A', 1, '入', ['T1'], '08:00'),
    scan('坡A', 2, '出', ['T1'], '08:30'),
  ]);
  // 入与出两次通行都无法被组合单解释（缺挂），各产生一条异常
  assert.equal(badCombo.orders[0].paperworkProblems.length, 2);
  assert.equal(badCombo.orders[0].release.eligible, false);
  assert.match(badCombo.orders[0].release.reason, /手续存在授权不符/);

  const badTractor = derive([
    booking('O2', ['T2'], '牵引车'),
    scan('坡A', 3, '入', ['T2', 'G2'], '08:00'),
  ]);
  assert.equal(badTractor.orders[0].paperworkProblems.length, 1);

  // 同一牵引车持组合单 + 仅牵引车单时，单独驶出可被仅牵引车单解释
  const shared = derive([
    booking('O3', ['T3', 'G3'], '组合'),
    booking('O4', ['T3'], '牵引车'),
    scan('坡A', 4, '入', ['T3', 'G3'], '08:00'),
    scan('坡A', 5, '出', ['T3'], '08:30'),
  ]);
  assert.deepEqual(shared.orders.flatMap((o) => o.paperworkProblems), []);
});

test('水位线之前的缺口标不可补，之后的缺口标待补', () => {
  const view = derive([
    scan('坡A', 10, '入', ['T1'], '08:00'),
    scan('坡A', 13, '出', ['T1'], '08:40'),
    floor('坡A', 12),
  ]);
  // 读数 10 与 13 之间缺 11、12；水位 12 之下只有 11 不可补，12 待补
  assert.deepEqual(view.gaps.filter((g) => g.kind === '不可补缺口').map((g) => g.seq), [11]);
  assert.deepEqual(view.gaps.filter((g) => g.kind === '待补缺口').map((g) => g.seq), [12]);
});

test('在船但无层位证据的实物与交班未清项进入未知清单', () => {
  const view = derive([
    booking('O1', ['T1', 'G1'], '组合'),
    scan('坡A', 1, '入', ['T1', 'G1'], '08:00'),
    signoff('HB1', 'L0', 'L1', '09:00', {}, ['D5']),
  ]);
  assert.deepEqual(view.unknown.uncoveredAssets.map((x) => x.asset).sort(), ['G1', 'T1']);
  assert.equal(view.unknown.openHandoverItems[0].slot, 'D5');
});

test('补录更高 rev 后在位视图重算，差异交接包含原结论与差异实物', () => {
  const events = [
    booking('O1', ['T1', 'G1'], '组合'),
    rebook('O1', 'L1', '09:00'),
    scan('坡A', 1, '入', ['T1', 'G1'], '08:00'),
    detach('L0', 'L2', 'D3', 'T1', 'G1', '08:10'),
    count('L0', 'L2', '08:15', ['D3'], { D3: 'G1' }),
    scan('坡A', 2, '出', ['T1'], '08:30'),
    signoff('HB1', 'L0', 'L2', '09:00', { D3: 'G1' }),
  ];
  const before = derive(events);
  assert.equal(before.handovers[0].status, '有效');
  assert.equal(before.orders[0].release.eligible, false);

  events.push(scan('坡A', 2, '出', ['T1', 'G1'], '08:30', 2));
  const after = derive(events);
  assert.equal(after.handovers[0].status, '已被补录推翻');
  assert.equal(after.handovers[0].differences[0].asset, 'G1');
  assert.match(after.handovers[0].differences[0].signedReason, /HB1/);
  assert.equal(after.orders[0].release.eligible, true);
});

test('人工清点的覆盖边界之外不推断在位，空位以 absent 明示', () => {
  const view = derive([
    count('L0', 'L2', '08:15', ['D3', 'D4'], { D3: 'G1' }, ['D4']),
  ]);
  const slots = view.deck.layers[0].slots;
  assert.equal(slots.find((s) => s.slot === 'D3').status, '占用');
  assert.equal(slots.find((s) => s.slot === 'D4').status, '清点证空');
  assert.deepEqual(view.unknown.uncountedSlots, []);
});
