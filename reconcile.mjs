// 纯函数核对引擎：给定全部事件，重放得到当前的票务、通行、甲板与交班视图。
// 不做任何 IO，便于单元测试；补录事件后重新调用 derive 即完成重算。

// ---------- 基础工具 ----------

const cmpTime = (a, b) => {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

const unique = (arr) => [...new Set(arr)];
const keyOf = (station, seq) => `${station}#${seq}`;

function orderedEvents(events) {
  const rank = { scan: 1, detach: 2, attach: 2, count: 3, signoff: 4, clear: 5, floor: 6 };
  return [...events].sort((a, b) => {
    const t = cmpTime(a.time, b.time);
    if (t !== 0) return t;
    const r = (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9);
    if (r !== 0) return r;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

// ---------- 主推导 ----------

export function derive(events) {
  const list = orderedEvents(events);

  // 1) 票务：过渡单、当前航次、授权与改签链
  const orders = new Map();
  for (const e of list) {
    if (e.kind === 'booking') {
      orders.set(e.payload.order, {
        order: e.payload.order,
        leg: e.payload.leg,
        assets: [...e.payload.assets],
        permission: e.payload.permission,
        rebookedTo: null,
        rebookHistory: [],
        record: e.key,
      });
    } else if (e.kind === 'rebook') {
      const order = orders.get(e.payload.order);
      if (!order) continue;
      order.rebookHistory.push({ from: order.leg, to: e.payload.leg, time: e.payload.time, record: e.key });
      order.rebookedTo = e.payload.leg;
      order.leg = e.payload.leg;
    }
  }

  // 2) 坡道：按设备保留各 seq 的全部修订，取最高 rev 为当前读数
  const passages = new Map();
  const floorWatermark = new Map();
  for (const e of list) {
    if (e.kind === 'scan') {
      const id = keyOf(e.payload.station, e.payload.seq);
      const existing = passages.get(id);
      const rev = e.payload.rev ?? 1;
      if (!existing || rev > existing.current.rev) {
        passages.set(id, {
          id,
          station: e.payload.station,
          seq: e.payload.seq,
          current: { ...e.payload, rev, record: e.key },
          revisions: existing ? [...existing.revisions, { rev, record: e.key, assets: [...e.payload.assets] }]
            : [{ rev, record: e.key, assets: [...e.payload.assets] }],
        });
      } else {
        existing.revisions.push({ rev, record: e.key, assets: [...e.payload.assets] });
      }
    } else if (e.kind === 'floor') {
      // 回卷水位：该设备只保证 seq >= oldest 仍可取，之前的缺口已无法补取。
      const prev = floorWatermark.get(e.payload.station);
      if (prev == null || e.payload.oldest > prev) floorWatermark.set(e.payload.station, e.payload.oldest);
    }
  }
  const passageList = [...passages.values()].sort((a, b) => a.seq - b.seq);

  // 缺口分类：水位线之前且无读数 = 不可补；水位线之后且无读数 = 待补
  const gaps = [];
  const byStation = new Map();
  for (const p of passageList) {
    if (!byStation.has(p.station)) byStation.set(p.station, []);
    byStation.get(p.station).push(p.seq);
  }
  for (const [station, seqs] of byStation) {
    const watermark = floorWatermark.get(station);
    const sorted = [...seqs].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      for (let seq = sorted[i] + 1; seq < sorted[i + 1]; seq += 1) {
        gaps.push({
          station,
          seq,
          kind: watermark != null && seq < watermark ? '不可补缺口' : '待补缺口',
          watermark: watermark ?? null,
        });
      }
    }
  }

  // 3) 实物移动时间线：只按实物身份（asset token）与通行关联，不按车牌复用推断
  const movements = [];
  const addMove = (m) => movements.push(m);
  for (const p of passageList) {
    const c = p.current;
    for (const asset of unique(c.assets)) {
      addMove({
        asset,
        type: c.direction === '入' ? '坡道入船' : '坡道出船',
        time: c.time,
        leg: c.leg,
        layer: null,
        slot: null,
        record: c.record,
        detail: `${c.station} seq${c.seq}(rev${c.rev}) 周期${c.cycle} 向${c.direction}`,
      });
    }
  }
  for (const e of list) {
    const p = e.payload;
    if (e.kind === 'detach') {
      addMove({ asset: p.trailer, type: '解挂', time: p.time, leg: p.leg, layer: p.layer, slot: p.slot, record: e.key, detail: `牵引车${p.tractor}解挂后停于${p.layer}/${p.slot}` });
    } else if (e.kind === 'attach') {
      addMove({ asset: p.trailer, type: '挂接', time: p.time, leg: p.leg, layer: p.layer, slot: p.slot, record: e.key, detail: `牵引车${p.tractor}在${p.layer}/${p.slot}挂接` });
    }
  }
  movements.sort((a, b) => {
    const t = cmpTime(a.time, b.time);
    if (t !== 0) return t;
    return a.record < b.record ? -1 : 1;
  });

  // 实物在某时刻的状态：船上（含所在层位）或船外
  const stateAt = (asset, time) => {
    let state = { onBoard: false, layer: null, slot: null, last: null };
    for (const m of movements) {
      if (m.asset !== asset) continue;
      if (time != null && cmpTime(m.time, time) > 0) break;
      state.last = m;
      if (m.type === '坡道入船') state = { onBoard: true, layer: null, slot: null, last: m };
      else if (m.type === '坡道出船') state = { onBoard: false, layer: null, slot: null, last: m };
      else if (m.type === '解挂') state = { onBoard: true, layer: m.layer, slot: m.slot, last: m };
      else if (m.type === '挂接') state = { onBoard: true, layer: null, slot: null, last: m };
    }
    return state;
  };

  const currentState = (asset) => stateAt(asset, null);

  // 4) 甲板舱位事件与清舱位置
  const slotEvents = [];
  const clearedSlots = new Map(); // `${leg}/${layer}/${slot}` -> clear 事件
  const signoffs = [];
  const counts = [];
  for (const e of list) {
    const p = e.payload;
    if (e.kind === 'detach' || e.kind === 'attach') {
      slotEvents.push({ kind: e.kind, leg: p.leg, layer: p.layer, slot: p.slot, asset: p.trailer, time: p.time, record: e.key });
    } else if (e.kind === 'count') {
      counts.push({ ...p, record: e.key });
      for (const slot of p.covered ?? []) {
        slotEvents.push({
          kind: 'count',
          leg: p.leg,
          layer: p.layer,
          slot,
          asset: p.present?.[slot] ?? null,
          absent: (p.absent ?? []).includes(slot),
          time: p.time,
          record: e.key,
        });
      }
    } else if (e.kind === 'clear') {
      for (const slot of p.slots ?? []) {
        const id = `${p.leg}/${p.layer}/${slot}`;
        clearedSlots.set(id, { leg: p.leg, layer: p.layer, slot, time: p.time, record: e.key });
        slotEvents.push({ kind: 'clear', leg: p.leg, layer: p.layer, slot, asset: null, time: p.time, record: e.key });
      }
    } else if (e.kind === 'signoff') {
      signoffs.push({ ...p, record: e.key });
      // 签收是一种舱位主张：进入舱位事件流，但 verified 由独立证据决定。
      for (const [slot, asset] of Object.entries(p.seen ?? {})) {
        slotEvents.push({ kind: 'signoff', leg: p.leg, layer: p.layer, slot, asset, time: p.time, record: e.key });
      }
    }
  }
  slotEvents.sort((a, b) => {
    const t = cmpTime(a.time, b.time);
    return t !== 0 ? t : a.record < b.record ? -1 : 1;
  });

  // 5) 舱位在位视图：结论必须由证据支撑，否则列为未知
  const slotIndex = new Map();
  const indexSlot = (leg, layer, slot) => {
    const id = `${leg}/${layer}/${slot}`;
    if (!slotIndex.has(id)) slotIndex.set(id, { leg, layer, slot, events: [] });
    return slotIndex.get(id);
  };
  for (const se of slotEvents) indexSlot(se.leg, se.layer, se.slot).events.push(se);

  const slotView = (leg, layer, slot) => {
    const entry = slotIndex.get(`${leg}/${layer}/${slot}`);
    const evs = entry ? entry.events : [];
    const last = evs.length ? evs[evs.length - 1] : null;
    let status = '未知';
    let asset = null;
    let verified = false;
    const reasons = [];

    for (const se of evs) {
      if (se.kind === 'detach') {
        status = '占用'; asset = se.asset; verified = true;
        reasons.push(`${se.time} 解挂记录：${se.asset} 停入 ${se.slot}（${se.record}）`);
      } else if (se.kind === 'attach') {
        status = '已挂接待运'; asset = se.asset; verified = true;
        reasons.push(`${se.time} 挂接记录：${se.asset} 在 ${se.slot} 被牵引车挂走（${se.record}）`);
      } else if (se.kind === 'clear') {
        status = '已清舱'; asset = null; verified = true;
        reasons.push(`${se.time} 清舱记录：${se.slot} 清空（${se.record}）`);
      } else if (se.kind === 'count') {
        if (se.absent) {
          status = '清点证空'; asset = null; verified = true;
          reasons.push(`${se.time} 人工清点（覆盖${(counts.find((c) => c.record === se.record)?.covered ?? []).join('、')}）：${se.slot} 明示空位（${se.record}）`);
        } else if (se.asset) {
          status = '占用'; asset = se.asset; verified = true;
          reasons.push(`${se.time} 人工清点（覆盖${(counts.find((c) => c.record === se.record)?.covered ?? []).join('、')}）：${se.slot} 在位 ${se.asset}（${se.record}）`);
        }
      } else if (se.kind === 'signoff') {
        // 签收主张可以占位，但不得覆盖已核实的清舱/证空等结论；无独立证据时保持待证
        if (verified && status !== '占用' && status !== '已挂接待运') {
          status = '签收主张与已核实结论冲突'; verified = false; asset = se.asset;
          reasons.push(`${se.time} 交班签收主张 ${se.asset} 位于 ${se.slot}，但该舱位已有已核实结论（${se.record}）`);
        } else if (status === '未知') {
          status = '签收待证'; asset = se.asset;
          reasons.push(`${se.time} 交班签收主张 ${se.asset} 位于 ${se.slot}，无挂接/清点独立证据（${se.record}）`);
        } else {
          reasons.push(`${se.time} 交班签收主张 ${se.asset} 位于 ${se.slot}（${se.record}）`);
        }
      }
    }
    if (!verified && status === '占用') {
      status = '签收待证';
      reasons.push('该占用仅有签收主张，未获挂接或清点证据核实');
    }
    // 坡道出船证据证实实物已离船，但甲板终端尚未补清舱：
    // 舱位结论标记为通行证离、待甲板核实，不能继续当作已装好。
    if (asset) {
      const st = stateAt(asset, null);
      if (!st.onBoard && st.last && st.last.type === '坡道出船') {
        status = '通行证离待核实';
        verified = false;
        reasons.push(`${st.last.time} 坡道通行证实 ${asset} 已出船（${st.last.record}），甲板终端尚无对应清舱`);
      }
    }
    return { leg, layer, slot, status, asset, verified, reasons, lastRecord: last?.record ?? null };
  };

  // 6) 交接班：签收快照冻结当时依据，补录推翻后生成差异交接并标记原结论失效
  const acknowledgements = new Map();
  for (const e of list) {
    if (e.kind === 'ack-discrepancy') {
      acknowledgements.set(e.payload.discrepancyId, { at: e.payload.time ?? null, by: e.payload.by ?? null, record: e.key });
    }
  }

  const handovers = signoffs.map((s) => {
    const claimed = Object.entries(s.seen ?? {}).map(([slot, asset]) => ({
      slot,
      asset,
      slotView: slotView(s.leg, s.layer, slot),
      stateNow: currentState(asset),
    }));
    const differences = claimed
      .filter((c) => !c.stateNow.onBoard || (c.slotView.asset !== null && c.slotView.asset !== c.asset))
      .map((c) => ({
        asset: c.asset,
        slot: c.slot,
        signedReason: `交班 ${s.id}（${s.time}）签收 ${c.asset} 位于 ${s.layer}/${c.slot}`,
        currentState: c.stateNow.onBoard ? `船上（${c.stateNow.layer ?? '未定位层位'}/${c.stateNow.slot ?? '未定位舱位'}）` : '已不在船',
        currentEvidence: c.stateNow.last
          ? `${c.stateNow.last.time} ${c.stateNow.last.type}：${c.stateNow.last.detail}（${c.stateNow.last.record}）`
          : '无后续实物移动记录',
        currentSlotStatus: c.slotView.status,
      }));
    const overturned = differences.length > 0;
    const discrepancyId = overturned ? `差异-${s.id}` : null;
    return {
      id: s.id,
      leg: s.leg,
      layer: s.layer,
      time: s.time,
      record: s.record,
      openItems: [...(s.unchecked ?? [])],
      snapshot: {
        seen: s.seen ?? {},
        unchecked: [...(s.unchecked ?? [])],
        reasons: Object.entries(s.seen ?? {}).map(([slot, asset]) => {
          const view = slotView(s.leg, s.layer, slot);
          const why = view.reasons.join('；') || '无独立证据，仅凭签收当时所见';
          return `签收 ${asset} 于 ${s.layer}/${slot}：${why}`;
        }),
      },
      status: overturned ? '已被补录推翻' : '有效',
      differences,
      discrepancyId,
      acknowledged: discrepancyId ? acknowledgements.has(discrepancyId) : null,
      acknowledgement: discrepancyId ? acknowledgements.get(discrepancyId) ?? null : null,
    };
  });

  const activeHandovers = handovers.filter((h) => h.status === '有效');

  // 7) 冲突不变量
  const conflicts = [];

  // 7a) 同一实物同时被两个当前甲板记作已装好（按时刻重叠的在船层位段判定）
  const deckSpans = new Map();
  for (const m of movements) {
    if (!m.layer || !m.slot) continue;
    if (!deckSpans.has(m.asset)) deckSpans.set(m.asset, []);
    deckSpans.get(m.asset).push(m);
  }
  for (const [asset, ms] of deckSpans) {
    const spans = [];
    let open = null;
    for (const m of ms) {
      if (m.type === '解挂') {
        if (open) {
          // 上一舱位没有挂接/出船记录又在别处解挂：两个层位段时间重叠，记冲突
          spans.push({ ...open, to: null, endRecord: null, premature: true });
        }
        open = { layer: m.layer, slot: m.slot, from: m.time, record: m.record };
      } else if (m.type === '挂接' && open) {
        spans.push({ ...open, to: m.time, endRecord: m.record });
        open = null;
      }
    }
    if (open) spans.push({ ...open, to: null, endRecord: null });
    for (let i = 0; i < spans.length; i += 1) {
      for (let j = i + 1; j < spans.length; j += 1) {
        const a = spans[i];
        const b = spans[j];
        const overlap = cmpTime(a.from, b.to ?? '99:99') < 0 && cmpTime(b.from, a.to ?? '99:99') < 0;
        if (overlap && (a.layer !== b.layer || a.slot !== b.slot)) {
          conflicts.push({
            kind: '同一实物重复装载',
            asset,
            locations: [`${a.layer}/${a.slot}`, `${b.layer}/${b.slot}`],
            records: [a.record, b.record],
            message: `${asset} 在时间重叠区间同时被记作位于 ${a.layer}/${a.slot} 与 ${b.layer}/${b.slot}`,
          });
        }
      }
    }
  }

  // 7b) 未核清的车不能占别人已经签收的释放位置（清舱/清点证空后又被无证据主张占用）
  for (const [id, clear] of clearedSlots) {
    const [leg, layer, slot] = id.split('/');
    const view = slotView(leg, layer, slot);
    if (!view.verified && ['签收待证', '占用', '签收主张与已核实结论冲突'].includes(view.status)) {
      conflicts.push({
        kind: '未核清占用释放位置',
        slot: id,
        asset: view.asset,
        records: [clear.record, view.lastRecord],
        message: `${id} 已由 ${clear.record} 签收释放，当前主张 ${view.asset ?? '未知实物'} 占用但无有效证据，未核清车辆不得占用`,
      });
    }
  }

  // 7c) 同一实物被两个仍有效交班在不同层位签收
  const claims = new Map();
  for (const h of activeHandovers) {
    for (const [slot, asset] of Object.entries(h.snapshot.seen)) {
      if (!claims.has(asset)) claims.set(asset, []);
      claims.get(asset).push({ handover: h.id, leg: h.leg, layer: h.layer, slot });
    }
  }
  for (const [asset, list2] of claims) {
    const layers = unique(list2.map((c) => c.layer));
    if (layers.length > 1) {
      conflicts.push({
        kind: '重复签收',
        asset,
        claims: list2,
        message: `${asset} 被有效交班同时签收于不同甲板：${list2.map((c) => `${c.handover}@${c.layer}/${c.slot}`).join('、')}`,
      });
    }
  }

  // 8) 过渡单核对与候补释放判断
  // 一辆牵引车可同时持有多张过渡单（如组合单 + 仅牵引车单），因此一条通行只要能被
  // 任一在授权期内的过渡单解释即算手续有效；解释不了的通行才列为票务异常。
  const explainPassage = (p) => {
    const c = p.current;
    const moved = new Set(c.assets);
    const explanations = [];
    for (const o of orders.values()) {
      const known = new Set(o.assets);
      let ok = false;
      if (o.permission === '牵引车') {
        ok = moved.size > 0 && [...moved].every((a) => known.has(a));
      } else if (o.permission === '组合') {
        ok = [...known].every((a) => moved.has(a));
      }
      if (ok) explanations.push(o.order);
    }
    return explanations;
  };

  const unexplainedPassages = passageList
    .map((p) => ({ p, explainedBy: explainPassage(p) }))
    .filter((x) => x.explainedBy.length === 0);

  const orderResults = [...orders.values()].map((o) => {
    const problems = [];
    const assetSummaries = o.assets.map((a) => {
      const s = currentState(a);
      return { asset: a, onBoard: s.onBoard, layer: s.layer, slot: s.slot, lastMovement: s.last };
    });
    for (const { p } of unexplainedPassages) {
      const c = p.current;
      if (!c.assets.some((a) => o.assets.includes(a))) continue;
      problems.push({
        kind: '授权不符',
        passage: p.id,
        record: c.record,
        detail: `通行 ${p.id} 车组 ${c.assets.join('、')} 无法被任何过渡单授权解释，涉及本单实物`,
      });
    }
    const physicalClear = assetSummaries.every((a) => !a.onBoard);
    const blockedBy = assetSummaries.filter((a) => a.onBoard).map((a) => ({
      asset: a.asset,
      layer: a.layer,
      slot: a.slot,
      evidence: a.lastMovement ? `${a.lastMovement.time} ${a.lastMovement.type}（${a.lastMovement.record}）` : '在船但无定位记录',
    }));
    const rebooked = o.rebookedTo != null;
    let release;
    if (!rebooked) {
      release = { eligible: false, reason: '未改签，按原航次交接，不涉及候补释放' };
    } else if (problems.length) {
      release = { eligible: false, reason: '手续存在授权不符，需先处理票务异常', problems: problems.map((x) => x.detail) };
    } else if (!physicalClear) {
      release = { eligible: false, reason: '仅凭票务改签不能释放；以下实物仍有在船证据', blockedBy };
    } else {
      release = {
        eligible: true,
        reason: `已证实实物不再占位，且手续有效，可向航次 ${o.rebookedTo} 的候补释放`,
        evidence: assetSummaries.map((a) => (a.lastMovement
          ? `${a.asset}: ${a.lastMovement.time} ${a.lastMovement.type}（${a.lastMovement.record}）`
          : `${a.asset}: 无在船记录`)),
      };
    }
    return {
      order: o.order,
      currentLeg: o.leg,
      originalLeg: o.rebookHistory.length ? o.rebookHistory[0].from : o.leg,
      rebookedTo: o.rebookedTo,
      rebookHistory: o.rebookHistory,
      permission: o.permission,
      assets: assetSummaries,
      paperworkProblems: problems,
      release,
    };
  });

  // 9) 清点之外仍未知的位置：单列，不与有证据的结论混淆
  const unknown = {
    gaps,
    uncoveredAssets: unique(movements.map((m) => m.asset))
      .map((asset) => ({ asset, state: currentState(asset) }))
      .filter((x) => x.state.onBoard && x.state.layer == null)
      .map((x) => ({
        asset: x.asset,
        reason: `最后记录为 ${x.state.last.time} ${x.state.last.type}（${x.state.last.record}），在船但无甲板层位证据`,
      })),
    uncountedSlots: [],
    openHandoverItems: handovers.flatMap((h) => h.openItems.map((slot) => ({
      handover: h.id, leg: h.leg, layer: h.layer, slot,
      reason: `交班 ${h.id} 明示未核清舱位 ${slot}`,
    }))),
  };
  const coveredKeys = new Set();
  for (const c of counts) for (const slot of c.covered ?? []) coveredKeys.add(`${c.leg}/${c.layer}/${slot}`);
  for (const id of slotIndex.keys()) {
    if (!coveredKeys.has(id)) {
      const [leg, layer, slot] = id.split('/');
      const view = slotView(leg, layer, slot);
      if (view.status === '未知') unknown.uncountedSlots.push({ slot: id, reason: view.reasons[0] });
    }
  }

  // 10) 汇总三本账
  const legs = unique([
    ...orders.values(),
  ].flatMap((o) => [o.leg, ...o.rebookHistory.map((r) => r.from), ...o.rebookHistory.map((r) => r.to)]));
  const legStats = legs.map((leg) => ({
    leg,
    bookingOrders: orderResults.filter((o) => o.originalLeg === leg || o.currentLeg === leg).map((o) => o.order),
    rampPassages: passageList.filter((p) => p.current.leg === leg).map((p) => p.id),
    signedLayers: handovers.filter((h) => h.leg === leg).map((h) => `${h.layer}(${h.id}/${h.status})`),
  }));

  return {
    orders: orderResults,
    passages: passageList,
    gaps,
    floorWatermark: [...floorWatermark.entries()].map(([station, oldest]) => ({ station, oldest })),
    movements,
    deck: {
      layers: [...new Set(slotEvents.map((s) => `${s.leg}/${s.layer}`))].map((id) => {
        const [leg, layer] = id.split('/');
        const slots = [...new Set(slotEvents.filter((s) => s.leg === leg && s.layer === layer).map((s) => s.slot))]
          .map((slot) => slotView(leg, layer, slot));
        return { leg, layer, slots };
      }),
      slotView,
      counts,
      cleared: [...clearedSlots.values()],
    },
    handovers,
    conflicts,
    unknown,
    legStats,
  };
}
