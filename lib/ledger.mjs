export class DomainError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const IN_DIRECTIONS = new Set(['入', '进', 'in', 'entry', 'inbound']);
const OUT_DIRECTIONS = new Set(['出', 'out', 'exit', 'outbound']);

export function normalizeDirection(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (IN_DIRECTIONS.has(text)) return 'in';
  if (OUT_DIRECTIONS.has(text)) return 'out';
  return 'unknown';
}

export function timeRank(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (clock) {
    return Number(clock[1]) * 60 + Number(clock[2]) + (clock[3] ? Number(clock[3]) / 60 : 0);
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed / 60000;
}

export function compareTime(a, b) {
  const ra = timeRank(a);
  const rb = timeRank(b);
  if (ra !== null && rb !== null) return ra - rb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

export function atMost(time, at) {
  if (at === null || at === undefined || at === '') return true;
  if (time === null || time === undefined || time === '') return true; // undated evidence is retained but flagged
  return compareTime(time, at) <= 0;
}

export function sameAssets(a = [], b = []) {
  if (a.length !== b.length) return false;
  const left = new Set(a.map(String));
  return b.every((asset) => left.has(String(asset)));
}

export function normalizePermission(value) {
  const text = String(value ?? '');
  if (text.includes('组合') || /combination|combo|rigid/i.test(text)) return 'combination';
  if (text.includes('牵引') || /tractor/i.test(text)) return 'tractor_only';
  return 'unknown';
}

function normalizeSlotList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((slot) => String(slot));
  return [String(value)];
}

function normalizeSeen(value) {
  const entries = [];
  if (!value) return entries;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item)) entries.push({ slot: String(item[0]), asset: String(item[1]) });
      else if (item && typeof item === 'object') entries.push({ slot: String(item.slot), asset: String(item.asset ?? item.token) });
      else entries.push({ slot: String(item), asset: null });
    }
  } else if (typeof value === 'object') {
    for (const [slot, asset] of Object.entries(value)) entries.push({ slot, asset: asset === null ? null : String(asset) });
  }
  return entries;
}

function sanitizeId(value) {
  return String(value).replace(/[^A-Za-z0-9_.:-]+/g, '_');
}

export class Ledger {
  constructor(options = {}) {
    this.records = [];
    this.recordKeys = new Set();
    this.layouts = new Map();
    this.handoffs = [];
    this.waitlist = [];
    this.releases = [];
    this.handling = new Map();
    this.audit = [];
    this.counters = { handoff: 0, waitlist: 0, release: 0, manual: 0 };
    this.now = options.now ?? (() => new Date().toISOString());
    this.sourceStatus = new Map();
    if (options.state) this.loadJSON(options.state);
  }

  ingest(input, meta = {}) {
    if (!input || typeof input !== 'object') throw new DomainError(400, 'INVALID_RECORD', '来源记录必须是对象');
    const envelope = structuredClone(input);
    if (!envelope.record) {
      this.counters.manual += 1;
      envelope.record = `manual-${this.counters.manual}-${Date.now()}`;
    }
    if (this.recordKeys.has(envelope.record)) {
      return { duplicate: true, recordKey: envelope.record, handoffId: null };
    }
    envelope._order = this.records.length + 1;
    envelope._ingestedAt = this.now();
    envelope._meta = structuredClone(meta);
    this.records.push(envelope);
    this.recordKeys.add(envelope.record);
    if (meta.source) {
      this.sourceStatus.set(meta.source, {
        source: meta.source,
        lastCollectedAt: this.now(),
        stage: meta.stage ?? null,
        baseUrl: meta.baseUrl ?? null,
      });
    }
    this.audit.push({ at: this.now(), type: 'record_ingested', record: envelope.record, source: meta.source ?? 'manual' });

    let handoffId = null;
    if (envelope.kind === 'signoff') {
      const handoff = this.buildHandoffFromEnvelope(envelope);
      this.handoffs.push(handoff);
      handoffId = handoff.id;
      this.audit.push({ at: this.now(), type: 'handoff_recorded', handoffId, sourceRecord: envelope.record });
    }
    this.reconcileFindings();
    return { duplicate: false, recordKey: envelope.record, handoffId };
  }

  configureLayout(layer, slots) {
    if (!layer) throw new DomainError(400, 'LAYER_REQUIRED', '甲板层不能为空');
    this.layouts.set(String(layer), normalizeSlotList(slots));
    return { layer: String(layer), slots: this.layouts.get(String(layer)) };
  }

  getIdentityLabels({ evidencePredicate = null } = {}) {
    // 车牌只是标签：本系统绝不按车牌合并实物；身份键始终是 asset token + cycle/passage。
    const labels = new Map();
    const add = (token, plate) => {
      if (!token || !plate) return;
      const key = String(token);
      if (!labels.has(key)) labels.set(key, new Set());
      labels.get(key).add(String(plate));
    };
    const records = evidencePredicate ? this.records.filter(evidencePredicate) : this.records;
    for (const record of records) {
      const p = record.payload ?? {};
      if (p.plates && typeof p.plates === 'object') {
        for (const [token, plate] of Object.entries(p.plates)) add(token, plate);
      }
      if (p.asset) add(p.asset, p.plate ?? p.licensePlate);
      if (p.tractor) add(p.tractor, p.tractorPlate ?? p.tractorLicensePlate);
      if (p.trailer) add(p.trailer, p.trailerPlate ?? p.trailerLicensePlate);
    }
    return Object.fromEntries([...labels.entries()].map(([token, plates]) => [token, [...plates]]));
  }

  getOrders({ at = null, evidencePredicate = null } = {}) {
    const map = new Map();
    const records = evidencePredicate ? this.records.filter(evidencePredicate) : this.records;
    for (const record of records) {
      const p = record.payload ?? {};
      const orderId = p.order;
      if (!orderId || (record.kind !== 'booking' && record.kind !== 'rebook' && record.kind !== 'transfer')) continue;
      if (!map.has(orderId)) {
        map.set(orderId, {
          order: orderId,
          assets: Array.isArray(p.assets) ? p.assets.map(String) : [],
          permission: normalizePermission(p.permission),
          permissionLabel: p.permission ?? null,
          intervals: [],
          records: [],
        });
      }
      const order = map.get(orderId);
      order.records.push(record.record);
      if (record.kind === 'booking') {
        if (Array.isArray(p.assets) && p.assets.length) order.assets = p.assets.map(String);
        if (p.permission) {
          order.permission = normalizePermission(p.permission);
          order.permissionLabel = p.permission;
        }
        order.intervals.push({ leg: p.leg ?? null, at: p.time ?? '00:00', type: 'booking', recordKey: record.record });
      } else {
        order.intervals.push({ leg: p.leg ?? null, at: p.time ?? null, type: record.kind, recordKey: record.record });
      }
    }

    return [...map.values()].map((order) => {
      const intervals = order.intervals.slice().sort((a, b) => {
        const cmp = compareTime(a.at ?? '00:00', b.at ?? '00:00');
        if (cmp !== 0) return cmp;
        return 0;
      });
      let legAtTime = intervals[0]?.leg ?? null;
      if (at !== null) {
        for (const interval of intervals) {
          if (atMost(interval.at ?? '00:00', at)) legAtTime = interval.leg;
          else break;
        }
      }
      return {
        order: order.order,
        assets: order.assets,
        permission: order.permission,
        permissionLabel: order.permissionLabel,
        intervals,
        currentLeg: intervals.at(-1)?.leg ?? null,
        legAtTime,
        records: order.records,
      };
    });
  }

  getRamp({ evidencePredicate = null } = {}) {
    const groups = new Map();
    const records = evidencePredicate ? this.records.filter(evidencePredicate) : this.records;
    for (const record of records) {
      if (record.kind !== 'scan') continue;
      const p = record.payload ?? {};
      const station = p.station ?? '未命名坡道';
      const businessKey = p.seq === undefined || p.seq === null
        ? `cycle:${station}:${p.cycle ?? record.record}`
        : `seq:${station}:${p.seq}`;
      if (!groups.has(businessKey)) groups.set(businessKey, []);
      groups.get(businessKey).push(record);
    }

    const passages = [];
    for (const [key, revisions] of groups) {
      const sortedRevisions = revisions.slice().sort((a, b) => {
        const ra = Number(a.payload?.rev ?? 1);
        const rb = Number(b.payload?.rev ?? 1);
        if (ra !== rb) return ra - rb;
        return (a._order ?? 0) - (b._order ?? 0);
      });
      const effective = sortedRevisions.at(-1);
      const p = effective.payload ?? {};
      passages.push({
        key,
        station: p.station ?? '未命名坡道',
        seq: p.seq ?? null,
        rev: Number(p.rev ?? 1),
        cycle: p.cycle ?? null,
        direction: normalizeDirection(p.direction),
        directionLabel: p.direction ?? null,
        assets: Array.isArray(p.assets) ? p.assets.map(String) : [],
        leg: p.leg ?? null,
        at: p.time ?? null,
        effectiveRecord: effective.record,
        recordKeys: sortedRevisions.map((r) => r.record),
        revisions: sortedRevisions.map((r) => ({
          rev: Number(r.payload?.rev ?? 1),
          recordKey: r.record,
          at: r.payload?.time ?? null,
          direction: normalizeDirection(r.payload?.direction),
          assets: Array.isArray(r.payload?.assets) ? r.payload.assets.map(String) : [],
        })),
      });
    }

    passages.sort((a, b) => {
      const cmp = compareTime(a.at, b.at);
      if (cmp !== 0) return cmp;
      return Number(a.seq ?? 0) - Number(b.seq ?? 0);
    });

    const ordersAtTime = new Map();
    for (const passage of passages) {
      const timeKey = passage.at ?? '';
      if (!ordersAtTime.has(timeKey)) ordersAtTime.set(timeKey, this.getOrders({ at: passage.at, evidencePredicate }));
      const orders = ordersAtTime.get(timeKey);
      const matches = orders.filter((order) => {
        if (passage.leg && order.legAtTime && passage.leg !== order.legAtTime) return false;
        return sameAssets(order.assets, passage.assets);
      });
      passage.authorization = {
        status: matches.length ? 'authorized' : 'unmatched_authorization',
        orderIds: matches.map((order) => order.order),
        permission: matches.map((order) => order.permission),
      };
    }

    const movements = [];
    for (const passage of passages) {
      for (const asset of passage.assets) {
        movements.push({
          asset,
          at: passage.at,
          direction: passage.direction,
          passageKey: passage.key,
          cycle: passage.cycle,
          station: passage.station,
          seq: passage.seq,
          rev: passage.rev,
          leg: passage.leg,
          recordKey: passage.effectiveRecord,
          recordKeys: passage.recordKeys,
        });
      }
    }
    movements.sort((a, b) => compareTime(a.at, b.at) || (a.seq ?? 0) - (b.seq ?? 0));

    const byAsset = new Map();
    for (const movement of movements) {
      if (!byAsset.has(movement.asset)) byAsset.set(movement.asset, []);
      byAsset.get(movement.asset).push(movement);
    }

    const assetStates = {};
    for (const [asset, assetMovements] of byAsset) {
      const last = assetMovements.at(-1) ?? null;
      assetStates[asset] = {
        asset,
        state: !last ? 'unknown' : last.direction === 'in' ? 'aboard' : 'ashore',
        onboard: last ? last.direction === 'in' : null,
        last,
        lastIn: [...assetMovements].reverse().find((m) => m.direction === 'in') ?? null,
        lastOut: [...assetMovements].reverse().find((m) => m.direction === 'out') ?? null,
        movements: assetMovements,
      };
    }

    const gaps = this.getRampGaps(passages, evidencePredicate);
    return { passages, movements, assetStates, gaps };
  }

  getRampGaps(passages = this.getRamp().passages, evidencePredicate = null) {
    const floorRecords = evidencePredicate ? this.records.filter(evidencePredicate) : this.records;
    const floors = floorRecords
      .filter((r) => r.kind === 'floor')
      .map((r) => ({ station: r.payload?.station ?? '未命名坡道', oldest: Number(r.payload?.oldest), recordKey: r.record, order: r._order }));
    const stations = new Map();
    for (const passage of passages) {
      if (!stations.has(passage.station)) stations.set(passage.station, []);
      if (Number.isInteger(passage.seq)) stations.get(passage.station).push(passage.seq);
    }
    const result = [];
    for (const [station, seqs] of stations) {
      const sorted = [...new Set(seqs)].sort((a, b) => a - b);
      if (!sorted.length) continue;
      const floor = floors.filter((f) => f.station === station).sort((a, b) => b.order - a.order)[0] ?? null;
      const missing = [];
      for (let seq = sorted[0]; seq <= sorted.at(-1); seq += 1) {
        if (!sorted.includes(seq)) {
          missing.push({ seq, unrecoverable: Boolean(floor && seq < floor.oldest) });
        }
      }
      result.push({
        station,
        knownSequences: sorted,
        rewindOldest: floor?.oldest ?? null,
        floorRecord: floor?.recordKey ?? null,
        retainedBeforeBoundary: floor ? sorted.filter((seq) => seq < floor.oldest) : [],
        missingSequences: missing.map((item) => item.seq),
        unrecoverableSequences: missing.filter((item) => item.unrecoverable).map((item) => item.seq),
        historyBeforeBoundaryUnavailable: Boolean(floor),
      });
    }
    return result;
  }

  getDeckAssertions({ evidencePredicate = null } = {}) {
    const assertions = [];
    const records = evidencePredicate ? this.records.filter(evidencePredicate) : this.records;
    for (const record of records) {
      const p = record.payload ?? {};
      const base = {
        recordKey: record.record,
        kind: record.kind,
        layer: p.layer === undefined ? null : String(p.layer),
        leg: p.leg ?? null,
        at: p.time ?? null,
        order: record._order ?? 0,
        handoffId: p.id ?? null,
        officer: p.officer ?? p.signedBy ?? null,
      };
      const push = (slot, status, asset = null, extra = {}) => {
        if (!base.layer || slot === undefined || slot === null) return;
        assertions.push({
          ...base,
          slot: String(slot),
          status,
          asset: asset === null || asset === undefined ? null : String(asset),
          ...extra,
        });
      };

      if (record.kind === 'detach' || record.kind === 'attach' || record.kind === 'hook' || record.kind === 'unhook') {
        push(p.slot, 'occupied', p.trailer ?? p.asset, {
          tractor: p.tractor ?? null,
          coupling: record.kind,
        });
      } else if (record.kind === 'load') {
        push(p.slot, 'occupied', p.asset ?? p.trailer);
      } else if (record.kind === 'unload') {
        push(p.slot, 'empty', p.asset ?? p.trailer);
      } else if (record.kind === 'clear') {
        for (const slot of normalizeSlotList(p.slots ?? p.slot)) push(slot, 'empty', null, { clear: true });
      } else if (record.kind === 'count') {
        const covered = normalizeSlotList(p.covered ?? p.slots);
        const absent = new Set(normalizeSlotList(p.absent));
        const present = p.present ?? {};
        for (const slot of covered) {
          let asset = null;
          if (present instanceof Map) asset = present.get(slot);
          else if (Array.isArray(present)) {
            const found = present.find((item) => String(item.slot) === slot);
            asset = found?.asset ?? found?.token ?? null;
          } else asset = present[slot] ?? null;
          if (asset !== null && asset !== undefined) push(slot, 'occupied', asset, { count: true, covered: true });
          else if (absent.has(slot)) push(slot, 'empty', null, { count: true, absent: true, covered: true });
          else push(slot, 'unknown', null, { count: true, malformed: true, covered: true });
        }
      } else if (record.kind === 'signoff') {
        for (const item of normalizeSeen(p.seen)) {
          push(item.slot, item.asset ? 'occupied' : 'unknown', item.asset, { signed: true });
        }
        for (const slot of normalizeSlotList(p.empty ?? p.cleared)) push(slot, 'empty', null, { signed: true });
        for (const item of normalizeSeen(p.unchecked).length ? normalizeSeen(p.unchecked) : normalizeSlotList(p.unchecked).map((slot) => ({ slot }))) {
          push(item.slot, 'unknown', item.asset ?? null, { unchecked: true, reason: item.reason ?? 'officer_unchecked' });
        }
      }
    }
    return assertions.sort((a, b) => compareTime(a.at, b.at) || a.order - b.order);
  }

  buildView({ at = null, layer = null, leg = null, evidencePredicate = null } = {}) {
    const orders = this.getOrders({ at, evidencePredicate });
    const ramp = this.getRamp({ evidencePredicate });
    const identityLabels = this.getIdentityLabels({ evidencePredicate });
    const allAssertions = this.getDeckAssertions({ evidencePredicate }).filter((a) => atMost(a.at, at));
    const assertions = allAssertions.filter((a) => {
      if (layer && a.layer !== String(layer)) return false;
      if (leg && a.leg && a.leg !== leg) return false;
      return true;
    });

    const slotMap = new Map();
    const slotKey = (deckLayer, slot) => `${deckLayer}::${slot}`;
    const ensureSlot = (deckLayer, slot, slotLeg = null) => {
      const key = slotKey(deckLayer, slot);
      if (!slotMap.has(key)) {
        slotMap.set(key, { key, layer: String(deckLayer), slot: String(slot), leg: slotLeg, assertions: [], proofs: [], gaps: [] });
      }
      return slotMap.get(key);
    };

    for (const [deckLayer, slots] of this.layouts) {
      if (layer && deckLayer !== String(layer)) continue;
      for (const slot of slots) ensureSlot(deckLayer, slot);
    }
    for (const assertion of assertions) {
      const group = ensureSlot(assertion.layer, assertion.slot, assertion.leg);
      group.assertions.push(assertion);
      if (assertion.status === 'unknown') group.gaps.push(assertion);
      else group.proofs.push(assertion);
      if (!group.leg && assertion.leg) group.leg = assertion.leg;
    }

    const disputes = [];
    const addDispute = (dispute) => {
      const key = dispute.key ?? sanitizeId(`${dispute.code}:${dispute.layer ?? ''}:${dispute.slot ?? ''}:${dispute.asset ?? ''}:${dispute.handoffId ?? dispute.recordKey ?? ''}`);
      if (!disputes.some((item) => item.key === key)) disputes.push({ ...dispute, key });
    };

    const rampStateAt = (asset, when) => {
      const state = ramp.assetStates[asset];
      const movements = (state?.movements ?? []).filter((m) => atMost(m.at, when));
      const last = movements.at(-1) ?? null;
      return {
        state: !last ? 'unknown' : last.direction === 'in' ? 'aboard' : 'ashore',
        onboard: last ? last.direction === 'in' : null,
        last,
        movements,
      };
    };

    const slotRows = [];
    const activeClaims = [];
    for (const group of slotMap.values()) {
      group.proofs.sort((a, b) => compareTime(a.at, b.at) || a.order - b.order);
      group.gaps.sort((a, b) => compareTime(a.at, b.at) || a.order - b.order);
      let currentClaim = null;
      for (const proof of group.proofs) {
        if (proof.status === 'empty') {
          currentClaim = null;
        } else if (proof.status === 'occupied') {
          if (currentClaim?.asset && proof.asset && currentClaim.asset !== proof.asset) {
            addDispute({
              code: 'SLOT_OCCUPANT_CHANGED_WITHOUT_EMPTY_PROOF',
              layer: group.layer,
              slot: group.slot,
              handoffId: proof.handoffId,
              recordKey: proof.recordKey,
              message: `舱位 ${group.layer}/${group.slot} 在没有空舱证明的情况下由 ${currentClaim.asset} 变为 ${proof.asset}`,
              claims: [currentClaim, proof],
            });
          }
          currentClaim = proof;
        }
      }
      const latestProof = group.proofs.at(-1) ?? null;
      const latestGap = group.gaps.at(-1) ?? null;
      let row = {
        layer: group.layer,
        slot: group.slot,
        leg: group.leg,
        status: 'unknown',
        asset: null,
        at: latestProof?.at ?? latestGap?.at ?? null,
        proof: latestProof,
        latestGap,
        activeClaim: null,
        assessment: null,
        reasons: [],
        evidence: group.assertions,
      };

      if (currentClaim?.status === 'occupied' && currentClaim.asset) {
        const claim = currentClaim;
        activeClaims.push(claim);
        const atClaim = rampStateAt(claim.asset, claim.at);
        const currentRamp = rampStateAt(claim.asset, at);
        let assessment = 'occupied_proven';
        const reasons = ['DECK_OCCUPANCY_PROOF'];
        if (claim.signed) reasons.push('SIGNED_OBSERVATION');
        if (claim.count) reasons.push('MANUAL_COUNT_PRESENT');

        if (atClaim.state === 'ashore' && atClaim.last?.direction === 'out') {
          assessment = 'disputed_exit_before_claim';
          reasons.push('RAMP_EXIT_PROOF_PREDATES_CLAIM');
          addDispute({
            code: 'SIGNED_LOADING_OVERTURNED_BY_EXIT',
            severity: 'overturned_loading',
            layer: group.layer,
            slot: group.slot,
            asset: claim.asset,
            handoffId: claim.handoffId,
            recordKey: claim.recordKey,
            claimedAt: claim.at,
            exit: atClaim.last,
            signedConclusion: { layer: group.layer, slot: group.slot, asset: claim.asset, at: claim.at, handoffId: claim.handoffId },
            physicalDifference: {
              type: 'exit_passage',
              ...atClaim.last,
              assets: ramp.passages.find((passage) => passage.key === atClaim.last.passageKey)?.assets ?? [claim.asset],
              revisions: ramp.passages.find((passage) => passage.key === atClaim.last.passageKey)?.revisions ?? [],
            },
            responsibility: 'next_shift',
            message: `补录/更正的坡道驶出 ${atClaim.last.passageKey} 证明 ${claim.asset} 已离开，推翻 ${claim.handoffId ?? claim.recordKey} 在 ${claim.at} 的装载签收`,
          });
        } else if (currentRamp.state === 'ashore' && currentRamp.last?.direction === 'out' && compareTime(currentRamp.last.at, claim.at) >= 0) {
          const sameTime = compareTime(currentRamp.last.at, claim.at) === 0;
          assessment = sameTime ? 'disputed_same_time_exit' : 'vacated_by_exit';
          reasons.push(sameTime ? 'EXIT_AND_CLAIM_SAME_TIME' : 'RAMP_EXIT_VACATES_CLAIM');
          if (sameTime) {
            addDispute({
              code: 'OCCUPANCY_CLAIM_SAME_TIME_AS_EXIT',
              layer: group.layer,
              slot: group.slot,
              asset: claim.asset,
              handoffId: claim.handoffId,
              recordKey: claim.recordKey,
              exit: currentRamp.last,
              responsibility: 'next_shift',
              message: `${claim.asset} 的占用证明与驶出记录时间相同，需下一班核对先后`,
            });
          }
        } else if (currentRamp.state === 'aboard' && currentRamp.lastIn && compareTime(currentRamp.lastIn.at, claim.at) > 0) {
          assessment = 'stale_before_reentry';
          reasons.push('CLAIM_PREDATES_LATEST_ENTRY');
        }

        row = { ...row, status: assessment, asset: claim.asset, at: claim.at, proof: claim, activeClaim: claim, assessment, reasons };
      } else if (latestProof?.status === 'empty') {
        row.status = latestGap && compareTime(latestGap.at, latestProof.at) > 0 ? 'empty_last_proof_then_unchecked' : 'empty_proven';
        row.at = latestProof.at;
        row.reasons = [latestProof.clear ? 'CLEAR_PROOF' : latestProof.absent ? 'COUNT_ABSENT_PROOF' : 'EMPTY_PROOF'];
        if (row.status === 'empty_last_proof_then_unchecked') row.reasons.push('LATER_UNCHECKED');
      } else if (latestGap) {
        row.status = 'unknown_unchecked';
        row.at = latestGap.at;
        row.reasons = ['OFFICER_UNCHECKED'];
      } else if (this.layouts.has(group.layer)) {
        row.status = 'unknown_unobserved';
        row.reasons = ['NO_EVIDENCE'];
      }
      slotRows.push(row);
    }

    const claimsByAsset = new Map();
    const duplicateSlotKeys = new Set();
    for (const claim of activeClaims) {
      if (!claimsByAsset.has(claim.asset)) claimsByAsset.set(claim.asset, []);
      claimsByAsset.get(claim.asset).push(claim);
    }
    for (const [asset, claims] of claimsByAsset) {
      const distinctSlots = new Map(claims.map((claim) => [`${claim.layer}::${claim.slot}`, claim]));
      if (distinctSlots.size > 1) {
        for (const key of distinctSlots.keys()) duplicateSlotKeys.add(key);
        addDispute({
          code: 'ASSET_RECORDED_ON_MULTIPLE_DECKS',
          severity: 'duplicate_loading',
          asset,
          layer: claims[0].layer,
          slot: claims[0].slot,
          locations: [...distinctSlots.values()].map((claim) => ({ layer: claim.layer, slot: claim.slot, at: claim.at, recordKey: claim.recordKey, handoffId: claim.handoffId })),
          responsibility: 'next_shift',
          message: `同一实物 ${asset} 被记作在多个当前甲板位置已装好`,
        });
      }
    }
    for (const row of slotRows) {
      const key = `${row.layer}::${row.slot}`;
      row.countableOccupancy = row.status === 'occupied_proven' && !duplicateSlotKeys.has(key);
      if (duplicateSlotKeys.has(key)) {
        row.reconciliationStatus = 'duplicate_loading_conflict';
        row.countableOccupancy = false;
        if (!row.reasons.includes('DUPLICATE_CURRENT_DECK_CLAIM')) row.reasons.push('DUPLICATE_CURRENT_DECK_CLAIM');
      } else {
        row.reconciliationStatus = row.status;
      }
    }

    const orderAssets = new Set(orders.flatMap((order) => order.assets));
    const assetTokens = new Set([...orderAssets, ...Object.keys(ramp.assetStates), ...claimsByAsset.keys()]);
    const assets = [...assetTokens].sort().map((asset) => {
      const rampState = ramp.assetStates[asset] ?? { asset, state: 'unknown', onboard: null, last: null, lastIn: null, lastOut: null, movements: [] };
      const claims = claimsByAsset.get(asset) ?? [];
      const claimRows = slotRows.filter((row) => row.asset === asset && row.activeClaim);
      const validRows = claimRows.filter((row) => row.status === 'occupied_proven');
      const disputedRows = claimRows.filter((row) => row.status.startsWith('disputed'));
      const vacatedRows = claimRows.filter((row) => row.status === 'vacated_by_exit');
      let location = null;
      let locationStatus = 'unknown';
      if (validRows.length === 1) {
        location = { layer: validRows[0].layer, slot: validRows[0].slot, at: validRows[0].at };
        locationStatus = 'occupied';
      } else if (validRows.length > 1) {
        locationStatus = 'multiple_decks';
      } else if (disputedRows.length) {
        locationStatus = 'disputed';
      } else if (rampState.state === 'aboard') {
        locationStatus = 'aboard_slot_unknown';
      } else if (rampState.state === 'ashore') {
        locationStatus = 'ashore';
      }
      return {
        token: asset,
        plates: identityLabels[asset] ?? [],
        identityKey: 'asset-token+passage-association',
        orders: orders.filter((order) => order.assets.includes(asset)).map((order) => order.order),
        rampState: rampState.state,
        onboard: rampState.onboard,
        lastMovement: rampState.last,
        lastIn: rampState.lastIn,
        lastOut: rampState.lastOut,
        locationStatus,
        location,
        validLocations: validRows.map((row) => ({ layer: row.layer, slot: row.slot, at: row.at, status: row.status })),
        disputedLocations: disputedRows.map((row) => ({ layer: row.layer, slot: row.slot, at: row.at, status: row.status, proof: row.proof })),
        vacatedLocations: vacatedRows.map((row) => ({ layer: row.layer, slot: row.slot, at: row.at, status: row.status })),
        claims,
        movements: rampState.movements,
      };
    });

    const coverage = this.getCoverage(at, layer, evidencePredicate);
    const unknownLocations = [];
    for (const row of slotRows) {
      if (row.status.startsWith('unknown')) {
        unknownLocations.push({ kind: row.status, layer: row.layer, slot: row.slot, at: row.at, reason: row.reasons.join(',') });
      }
      if (row.status === 'disputed_exit_before_claim' || row.status === 'disputed_same_time_exit') {
        unknownLocations.push({ kind: 'disputed_location', layer: row.layer, slot: row.slot, asset: row.asset, at: row.at });
      }
    }
    for (const asset of assets) {
      if (asset.locationStatus === 'aboard_slot_unknown') {
        unknownLocations.push({ kind: 'asset_aboard_location_unknown', asset: asset.token, lastIn: asset.lastIn });
      }
    }
    for (const gap of ramp.gaps) {
      for (const seq of gap.unrecoverableSequences) {
        unknownLocations.push({ kind: 'unrecoverable_ramp_sequence_gap', station: gap.station, seq, rewindOldest: gap.rewindOldest });
      }
    }
    for (const item of coverage.outsideCoverage) unknownLocations.push(item);

    return {
      at,
      filters: { layer, leg },
      orders,
      ramp,
      slots: slotRows.sort((a, b) => a.layer.localeCompare(b.layer) || a.slot.localeCompare(b.slot)),
      assets,
      disputes,
      coverage,
      unknownLocations,
    };
  }

  getCoverage(at = null, layer = null, evidencePredicate = null) {
    const boundaries = [];
    const outsideCoverage = [];
    const records = evidencePredicate ? this.records.filter(evidencePredicate) : this.records;
    for (const record of records.filter((r) => r.kind === 'count')) {
      const p = record.payload ?? {};
      if (layer && String(p.layer) !== String(layer)) continue;
      if (!atMost(p.time, at)) continue;
      const covered = normalizeSlotList(p.covered ?? p.slots);
      const known = new Set([...(this.layouts.get(String(p.layer)) ?? [])]);
      for (const other of this.getDeckAssertions({ evidencePredicate }).filter((assertion) => atMost(assertion.at, at))) {
        if (other.layer === String(p.layer)) known.add(other.slot);
      }
      const outsideKnownSlots = [...known].filter((slot) => !covered.includes(slot)).sort();
      boundaries.push({
        recordKey: record.record,
        layer: String(p.layer),
        at: p.time ?? null,
        covered,
        present: p.present ?? {},
        absent: normalizeSlotList(p.absent),
        outsideKnownSlots,
        boundary: '仅 covered 列出的舱位与清点时刻可由本记录证明',
      });
      for (const slot of outsideKnownSlots) {
        outsideCoverage.push({ kind: 'outside_manual_count_coverage', layer: String(p.layer), slot, countRecord: record.record, countAt: p.time ?? null });
      }
    }
    return { boundaries, outsideCoverage };
  }

  buildHandoffFromEnvelope(record) {
    const p = record.payload ?? {};
    this.counters.handoff += 1;
    const id = p.id ?? `HB-${String(this.counters.handoff).padStart(4, '0')}`;
    const seen = normalizeSeen(p.seen);
    const empty = normalizeSlotList(p.empty ?? p.cleared);
    const unchecked = normalizeSeen(p.unchecked).length
      ? normalizeSeen(p.unchecked).map((item) => item.slot)
      : normalizeSlotList(p.unchecked);
    const openItems = Array.isArray(p.openItems) ? p.openItems : [];
    const hasOpenItems = unchecked.length > 0 || openItems.length > 0;
    const handoffStage = Number.isInteger(record.availableFrom) ? record.availableFrom : null;
    const handoffOrder = record._order ?? this.records.length;
    const evidencePredicate = (candidate) => {
      if (candidate.record === record.record) return true;
      if (handoffStage !== null && Number.isInteger(candidate.availableFrom)) {
        return candidate.availableFrom <= handoffStage;
      }
      return (candidate._order ?? 0) < handoffOrder;
    };
    const snapshot = this.buildView({ at: p.time ?? null, layer: p.layer ? String(p.layer) : null, evidencePredicate });
    const provenEmptySlots = snapshot.slots
      .filter((slot) => slot.status.startsWith('empty_proven'))
      .map((slot) => ({ layer: slot.layer, slot: slot.slot, at: slot.at, recordKey: slot.proof?.recordKey ?? null }));
    const occupiedSlots = snapshot.slots
      .filter((slot) => slot.countableOccupancy)
      .map((slot) => ({ layer: slot.layer, slot: slot.slot, asset: slot.asset, at: slot.at }));
    const unresolvedSlots = snapshot.slots
      .filter((slot) => slot.status.startsWith('unknown') || slot.status.startsWith('disputed') || slot.reconciliationStatus === 'duplicate_loading_conflict')
      .map((slot) => ({ layer: slot.layer, slot: slot.slot, status: slot.status }));
    const explicitCanContinueLoading = p.canContinueLoading ?? p.canLoadMore ?? p.loadingAllowed ?? null;
    const loadingDecision = {
      explicitCanContinueLoading: explicitCanContinueLoading === null ? null : Boolean(explicitCanContinueLoading),
      signedAvailableSlots: Array.isArray(p.availableSlots ?? p.freeSlots) ? (p.availableSlots ?? p.freeSlots).map(String) : null,
      capacity: p.capacity ?? null,
      provenEmptySlots,
      occupiedSlots,
      unresolvedSlots,
      derivedCanContinueLoading: provenEmptySlots.length > 0,
      effectiveCanContinueLoading: explicitCanContinueLoading === null ? provenEmptySlots.length > 0 : Boolean(explicitCanContinueLoading),
      basis: ['only covered/count/clear/signed evidence at handoff time is used', 'unchecked and disputed slots are not treated as proven empty'],
    };
    return {
      id,
      sourceRecord: record.record,
      sourceStage: record._meta?.stage ?? record.availableFrom ?? null,
      leg: p.leg ?? null,
      layer: p.layer ? String(p.layer) : null,
      at: p.time ?? null,
      officer: p.officer ?? p.signedBy ?? null,
      signed: {
        seen: Object.fromEntries(seen.filter((item) => item.asset).map((item) => [item.slot, item.asset])),
        empty,
        unchecked,
      },
      openItems,
      loadingDecision,
      status: hasOpenItems ? 'handed_over_with_open_items' : 'confirmed',
      responsibility: hasOpenItems ? 'next_shift_for_open_items' : 'next_shift_if_reversed_by_late_evidence',
      immutable: true,
      createdAt: this.now(),
      snapshot,
    };
  }

  createHandoff(body = {}) {
    if (!body.layer) throw new DomainError(400, 'LAYER_REQUIRED', '交班确认必须指定明确甲板 layer');
    const id = body.id ?? `HB-MANUAL-${String(this.counters.handoff + 1).padStart(4, '0')}`;
    if (this.handoffs.some((handoff) => handoff.id === id)) {
      throw new DomainError(409, 'HANDOFF_ID_EXISTS', `交班记录 ${id} 已存在且不可覆盖`);
    }
    const seenEntries = normalizeSeen(body.seen);
    const seen = Object.fromEntries(seenEntries.filter((item) => item.asset).map((item) => [item.slot, item.asset]));
    const unchecked = Array.isArray(body.unchecked) ? body.unchecked.map((item) => typeof item === 'string' ? item : item.slot) : [];
    const payload = {
      id,
      leg: body.leg ?? null,
      layer: String(body.layer),
      time: body.at ?? this.now(),
      officer: body.officer ?? body.signedBy ?? null,
      seen,
      empty: body.empty ?? [],
      unchecked,
      openItems: body.openItems ?? [],
      canContinueLoading: body.canContinueLoading ?? body.canLoadMore ?? null,
      availableSlots: body.availableSlots ?? body.freeSlots ?? null,
      capacity: body.capacity ?? null,
      note: body.note ?? null,
    };
    const result = this.ingest({ record: body.recordKey ?? `manual-handoff-${id}`, kind: 'signoff', payload }, { manual: true });
    return this.getHandoff(result.handoffId);
  }

  listHandoffs() {
    return this.handoffs.map(({ snapshot, ...summary }) => ({ ...summary, snapshotSummary: {
      orderCount: snapshot.orders.length,
      assetCount: snapshot.assets.length,
      occupied: snapshot.slots.filter((slot) => slot.countableOccupancy).length,
      unknown: snapshot.unknownLocations.length,
      disputes: snapshot.disputes.length,
    } }));
  }

  getHandoff(id) {
    const handoff = this.handoffs.find((item) => item.id === id);
    if (!handoff) throw new DomainError(404, 'HANDOFF_NOT_FOUND', `找不到交班记录 ${id}`);
    return handoff;
  }

  replayHandoff(id) {
    const handoff = this.getHandoff(id);
    const recalculatedThen = this.buildView({ at: handoff.at, layer: handoff.layer });
    const currentView = this.buildView({ layer: handoff.layer });
    const findings = this.listFindings().filter((finding) => finding.handoffId === handoff.id || finding.signedConclusion?.handoffId === handoff.id);
    const signedSlots = Object.entries(handoff.signed.seen).map(([slot, asset]) => {
      const signedRow = handoff.snapshot.slots.find((row) => row.slot === slot);
      const thenRow = recalculatedThen.slots.find((row) => row.slot === slot);
      const currentRow = currentView.slots.find((row) => row.slot === slot);
      const relatedDisputes = recalculatedThen.disputes.filter((d) => d.slot === slot && (!d.asset || d.asset === asset));
      return {
        layer: handoff.layer,
        slot,
        asset,
        signedAt: handoff.at,
        signedReason: signedRow?.reasons ?? ['SIGNED_OBSERVATION'],
        signedProof: signedRow?.proof ?? null,
        signedSnapshotStatus: signedRow?.status ?? null,
        recalculatedStatusAtHandoff: thenRow?.status ?? null,
        currentStatus: currentRow?.status ?? null,
        overturned: relatedDisputes.some((d) => d.code === 'SIGNED_LOADING_OVERTURNED_BY_EXIT'),
        disputes: relatedDisputes,
      };
    });
    return {
      id: handoff.id,
      immutableSignedRecord: handoff,
      signedSnapshot: handoff.snapshot,
      signedSlots,
      recalculatedThen,
      currentView,
      findings,
      overturned: signedSlots.some((slot) => slot.overturned) || findings.some((f) => f.status !== 'resolved' && f.code === 'SIGNED_LOADING_OVERTURNED_BY_EXIT'),
    };
  }

  reconcileFindings() {
    return this.listFindings();
  }

  listFindings({ status } = {}) {
    const view = this.buildView();
    const findings = view.disputes
      .filter((dispute) => dispute.responsibility === 'next_shift' || dispute.severity)
      .map((dispute) => {
        const handling = this.handling.get(dispute.key) ?? null;
        return {
          ...dispute,
          handoffId: dispute.handoffId ?? dispute.signedConclusion?.handoffId ?? null,
          responsibility: '下一班',
          ownerShift: 'next',
          status: handling?.status ?? 'pending_next_shift',
          handling: handling ?? { history: [] },
        };
      });
    return status ? findings.filter((finding) => finding.status === status) : findings;
  }

  getFinding(key) {
    const finding = this.listFindings().find((item) => item.key === key);
    if (!finding) throw new DomainError(404, 'FINDING_NOT_FOUND', `找不到差异/责任项 ${key}`);
    return finding;
  }

  actOnFinding(key, action, body = {}) {
    const finding = this.getFinding(key);
    const current = this.handling.get(key) ?? { status: finding.status, history: [] };
    const at = this.now();
    if (action === 'acknowledge') {
      current.status = 'accepted_by_next_shift';
      current.acceptedBy = body.by ?? body.officer ?? '下一班值班员';
      current.acceptedAt = at;
    } else if (action === 'assign') {
      current.status = 'assigned';
      current.assignee = body.assignee ?? body.to ?? null;
      current.assignedBy = body.by ?? null;
      current.assignedAt = at;
      if (!current.assignee) throw new DomainError(400, 'ASSIGNEE_REQUIRED', '指派处理责任时必须提供 assignee/to');
    } else if (action === 'resolve') {
      if (!body.resolution) throw new DomainError(400, 'RESOLUTION_REQUIRED', '结案必须提供 resolution');
      current.status = 'resolved';
      current.resolution = body.resolution;
      current.resolutionNote = body.note ?? null;
      current.resolvedBy = body.by ?? body.officer ?? null;
      current.resolvedAt = at;
    } else {
      throw new DomainError(400, 'UNKNOWN_FINDING_ACTION', `未知处理动作 ${action}`);
    }
    current.history.push({ action, at, by: body.by ?? body.officer ?? null, ...body });
    this.handling.set(key, current);
    this.audit.push({ at, type: `finding_${action}`, key });
    return this.getFinding(key);
  }

  addWaitlist(body = {}) {
    if (!body.leg) throw new DomainError(400, 'LEG_REQUIRED', '候补记录必须指定 leg 航次');
    this.counters.waitlist += 1;
    const order = body.order ? this.getOrders().find((item) => item.order === body.order) : null;
    const entry = {
      id: body.id ?? `WAIT-${String(this.counters.waitlist).padStart(4, '0')}`,
      leg: body.leg,
      order: body.order ?? null,
      assets: body.assets ? body.assets.map(String) : order?.assets ?? [],
      note: body.note ?? null,
      createdAt: this.now(),
    };
    this.waitlist.push(entry);
    return entry;
  }

  listWaitlist({ leg } = {}) {
    return leg ? this.waitlist.filter((entry) => entry.leg === leg) : this.waitlist;
  }

  evaluateBoardingAt(assets, at) {
    const view = this.buildView({ at });
    const states = assets.map((assetToken) => {
      const asset = view.assets.find((item) => item.token === assetToken);
      let state = 'unknown';
      if (asset?.locationStatus === 'occupied') state = 'aboard';
      else if (asset?.locationStatus === 'multiple_decks') state = 'conflict';
      else if (asset?.locationStatus === 'disputed') state = 'disputed';
      else if (asset?.rampState === 'aboard') state = 'aboard';
      else if (asset?.rampState === 'ashore' && asset?.locationStatus === 'ashore') state = 'ashore';
      else if (asset?.rampState === 'ashore') state = 'disputed';
      return { asset: assetToken, state, detail: asset ?? null };
    });
    let overall = 'unknown';
    if (states.some((item) => item.state === 'aboard')) overall = 'boarded';
    else if (states.some((item) => item.state === 'conflict' || item.state === 'disputed')) overall = 'disputed';
    else if (states.every((item) => item.state === 'ashore') && states.length) overall = 'not_boarded';
    return { at, overall, assets: states };
  }

  getAssetResolution(asset) {
    const resolved = this.listFindings()
      .filter((finding) => finding.status === 'resolved' && finding.asset === asset)
      .sort((a, b) => String(b.handling?.resolvedAt ?? '').localeCompare(String(a.handling?.resolvedAt ?? '')));
    const latest = resolved[0];
    if (!latest) return null;
    const resolution = String(latest.handling?.resolution ?? latest.resolution ?? '');
    if (resolution.includes('ramp') || resolution.includes('坡道')) return 'ramp_exit_confirmed';
    if (resolution.includes('signed') || resolution.includes('签收') || resolution.includes('deck')) return 'signed_claim_confirmed';
    return resolution || 'resolved';
  }

  evaluateRelease({ leg, order: orderId } = {}) {
    if (!leg) throw new DomainError(400, 'LEG_REQUIRED', '释放评估必须指定下一航次 leg');
    const view = this.buildView();
    const allFindings = this.listFindings();
    const allOrders = this.getOrders();
    let orders;
    if (orderId) {
      orders = allOrders.filter((order) => order.order === orderId);
    } else {
      const waitlistOrderIds = new Set(this.waitlist.filter((entry) => entry.leg === leg && entry.order).map((entry) => entry.order));
      orders = allOrders.filter((order) => order.currentLeg === leg || waitlistOrderIds.has(order.order));
    }
    return orders.map((order) => {
      const blockers = [];
      const warnings = [];
      if (order.currentLeg !== leg) {
        blockers.push({ code: 'NO_CURRENT_BOOKING_FOR_LEG', message: `过渡单当前航次为 ${order.currentLeg ?? '未知'}，不是 ${leg}` });
      }
      if (order.permission === 'unknown') blockers.push({ code: 'PERMISSION_UNKNOWN', message: '授权类型不是仅牵引车或牵引组合' });
      if (!order.assets.length) blockers.push({ code: 'ASSETS_MISSING', message: '过渡单没有实物 token' });
      if (order.permission === 'tractor_only' && order.assets.length !== 1) {
        blockers.push({ code: 'TRACTOR_ONLY_ASSET_MISMATCH', message: '仅牵引车授权应只对应一个实物 token' });
      }

      const rebook = [...order.intervals].reverse().find((interval) => interval.leg === leg && interval.type !== 'booking');
      let boardingAtTransfer = rebook?.at ? this.evaluateBoardingAt(order.assets, rebook.at) : { overall: 'original_booking', assets: [] };
      if (boardingAtTransfer.overall === 'disputed') {
        for (const assetState of boardingAtTransfer.assets) {
          const resolution = this.getAssetResolution(assetState.asset);
          if (resolution === 'ramp_exit_confirmed') assetState.state = 'ashore_resolved';
          if (resolution === 'signed_claim_confirmed') assetState.state = 'aboard_resolved';
        }
        if (boardingAtTransfer.assets.some((item) => item.state === 'aboard_resolved')) boardingAtTransfer.overall = 'boarded_after_resolution';
        else if (boardingAtTransfer.assets.every((item) => item.state === 'ashore_resolved' || item.state === 'ashore')) {
          boardingAtTransfer.overall = 'not_boarded_after_resolution';
        }
      }
      let transferStatus = 'original_booking_for_leg';
      if (rebook) {
        if (boardingAtTransfer.overall.startsWith('not_boarded')) transferStatus = 'valid_not_boarded';
        else if (boardingAtTransfer.overall === 'boarded' || boardingAtTransfer.overall === 'boarded_after_resolution') {
          transferStatus = 'invalid_was_boarded';
          blockers.push({ code: 'REBOOK_WHILE_BOARDED', message: `改签时刻 ${rebook.at} 仍有实物在船/在甲板，不能按未登船转移` });
        } else if (boardingAtTransfer.overall === 'disputed') {
          transferStatus = 'disputed_requires_shift_resolution';
          blockers.push({ code: 'TRANSFER_EVIDENCE_DISPUTED', message: '改签时刻是否未登船存在冲突，需下一班核清' });
        } else {
          transferStatus = 'unverified_not_proven_ashore';
          blockers.push({ code: 'TRANSFER_STATUS_UNVERIFIED', message: '没有证明改签时所有实物均未登船' });
        }
      }

      const previousLocations = order.assets.map((assetToken) => {
        const asset = view.assets.find((item) => item.token === assetToken);
        const occupiedAssertions = this.getDeckAssertions()
          .filter((a) => a.status === 'occupied' && a.asset === assetToken)
          .sort((a, b) => compareTime(a.at, b.at) || a.order - b.order);
        const claim = occupiedAssertions.at(-1) ?? null;
        const vacationProofs = [];
        let provenNoLongerOccupying = false;
        if (!claim && asset?.rampState === 'ashore' && asset.lastOut) {
          vacationProofs.push({ type: 'ramp_exit_without_deck_slot_claim', relationship: 'asset_ashore_after_passage', ...asset.lastOut });
          provenNoLongerOccupying = true;
        }
        if (claim && asset?.lastOut) {
          const relationship = compareTime(asset.lastOut.at, claim.at) > 0
            ? 'exit_after_claim_vacates_location'
            : compareTime(asset.lastOut.at, claim.at) < 0
              ? 'exit_before_sighting_contradicts_claim'
              : 'exit_same_time_needs_ordering';
          vacationProofs.push({ type: 'ramp_exit', relationship, ...asset.lastOut });
          provenNoLongerOccupying = relationship !== 'exit_same_time_needs_ordering';
        }
        if (claim) {
          const emptyProof = this.getDeckAssertions()
            .filter((a) => a.status === 'empty' && a.layer === claim.layer && a.slot === claim.slot && compareTime(a.at, claim.at) > 0)
            .sort((a, b) => compareTime(b.at, a.at) || b.order - a.order)[0];
          if (emptyProof) {
            vacationProofs.push({ type: emptyProof.kind === 'clear' ? 'deck_clear' : 'empty_proof', recordKey: emptyProof.recordKey, at: emptyProof.at, layer: emptyProof.layer, slot: emptyProof.slot });
            provenNoLongerOccupying = true;
          }
        }
        const relatedFindings = allFindings.filter((finding) => {
          const text = JSON.stringify(finding);
          return text.includes(assetToken) && (!claim || text.includes(claim.slot));
        });
        const openFindings = relatedFindings.filter((finding) => finding.status !== 'resolved');
        if (openFindings.length) blockers.push({ code: 'OPEN_HANDOVER_FINDING', asset: assetToken, findingKeys: openFindings.map((f) => f.key), message: `实物 ${assetToken} 有未结清的交班差异/责任项` });
        if (asset?.locationStatus === 'multiple_decks') blockers.push({ code: 'DUPLICATE_DECK_LOADING', asset: assetToken, message: `同一挂车 ${assetToken} 被记作在两个当前甲板已装好` });
        if (asset?.rampState === 'aboard' && asset.locationStatus !== 'occupied') {
          blockers.push({ code: 'ASSET_ABOARD_LOCATION_UNKNOWN', asset: assetToken, message: `实物 ${assetToken} 仍显示入船且甲板位置未核清` });
        }
        return {
          asset: assetToken,
          previousLocation: claim ? { layer: claim.layer, slot: claim.slot, at: claim.at, recordKey: claim.recordKey, handoffId: claim.handoffId } : null,
          currentReconciledLocation: asset?.location ?? null,
          locationStatus: asset?.locationStatus ?? 'unknown',
          provenNoLongerOccupying,
          vacationProofs,
          relatedFindings: relatedFindings.map((f) => ({ key: f.key, status: f.status, code: f.code })),
        };
      });

      if (previousLocations.some((item) => !item.provenNoLongerOccupying)) {
        blockers.push({ code: 'PREVIOUS_LOCATION_NOT_PROVEN_CLEAR', message: '上一处甲板/舱位没有证实不再占位' });
      }
      const formalitiesValid = !blockers.some((b) => ['NO_CURRENT_BOOKING_FOR_LEG', 'PERMISSION_UNKNOWN', 'ASSETS_MISSING', 'TRACTOR_ONLY_ASSET_MISMATCH', 'REBOOK_WHILE_BOARDED', 'TRANSFER_EVIDENCE_DISPUTED', 'TRANSFER_STATUS_UNVERIFIED'].includes(b.code));
      const releaseAllowed = blockers.length === 0;
      return {
        order: order.order,
        leg,
        currentBookingLeg: order.currentLeg,
        assets: order.assets,
        permission: order.permission,
        permissionLabel: order.permissionLabel,
        transferStatus,
        boardingAtTransfer,
        formalitiesValid,
        previousLocations,
        blockers,
        warnings,
        releaseAllowed,
        slotAssignmentAllowed: releaseAllowed,
      };
    });
  }

  createRelease(body = {}) {
    let leg = body.leg;
    let orderId = body.order;
    if (body.waitlistId) {
      const waitlistEntry = this.waitlist.find((entry) => entry.id === body.waitlistId);
      if (!waitlistEntry) throw new DomainError(404, 'WAITLIST_ENTRY_NOT_FOUND', `找不到候补记录 ${body.waitlistId}`);
      leg ??= waitlistEntry.leg;
      orderId ??= waitlistEntry.order;
    }
    if (!leg) throw new DomainError(400, 'LEG_REQUIRED', '释放必须指定航次 leg');
    const candidates = this.evaluateRelease({ leg, order: orderId });
    if (orderId && !candidates.length) throw new DomainError(404, 'RELEASE_CANDIDATE_NOT_FOUND', `找不到航次 ${leg} 下过渡单 ${orderId}`);
    if (!orderId && candidates.length > 1) throw new DomainError(400, 'ORDER_REQUIRED', `航次 ${leg} 有多个过渡单，请指定 order`, candidates.map((candidate) => candidate.order));
    const candidate = candidates[0];
    if (!candidate) throw new DomainError(404, 'RELEASE_CANDIDATE_NOT_FOUND', `航次 ${leg} 没有可评估的过渡单/候补车辆`);
    if (!candidate.releaseAllowed) {
      throw new DomainError(422, 'RELEASE_CONDITIONS_NOT_MET', '上一处未证实清空或手续无效/未核清', candidate);
    }

    let slot = null;
    if (body.slot || (body.layer && body.slotName)) {
      const layer = body.layer ?? body.slot?.layer;
      const slotName = body.slotName ?? body.slot?.slot ?? body.slot?.name;
      if (!layer || !slotName) throw new DomainError(400, 'SLOT_INVALID', '指定位置时必须提供 layer 和 slot');
      slot = { layer: String(layer), slot: String(slotName) };

      const view = this.buildView({ layer: slot.layer });
      const slotRow = view.slots.find((row) => row.slot === slot.slot);
      if (!slotRow || !slotRow.status.startsWith('empty_proven')) {
        throw new DomainError(422, 'TARGET_SLOT_NOT_PROVEN_EMPTY', '目标释放位置没有有效的空舱/清舱证明，不能安排未核清车辆', { slot, slotRow: slotRow ?? null });
      }
      const occupantRelease = this.releases.find((release) => release.status !== 'cancelled' && release.slot?.layer === slot.layer && release.slot?.slot === slot.slot);
      if (occupantRelease && occupantRelease.order !== orderId) {
        const code = occupantRelease.status === 'signed' ? 'SLOT_SIGNED_TO_OTHER' : 'SLOT_ALREADY_ASSIGNED';
        throw new DomainError(409, code, `位置 ${slot.layer}/${slot.slot} 已由过渡单 ${occupantRelease.order} 签收/占用`, occupantRelease);
      }
      if (occupantRelease && occupantRelease.order === orderId) return occupantRelease;
    }

    this.counters.release += 1;
    const release = {
      id: body.id ?? `REL-${String(this.counters.release).padStart(4, '0')}`,
      leg,
      order: candidate.order,
      assets: candidate.assets,
      slot,
      status: body.signedBy || body.sign === true ? 'signed' : slot ? 'assigned' : 'authorized',
      signedBy: body.signedBy ?? null,
      note: body.note ?? null,
      checks: candidate,
      createdAt: this.now(),
    };
    this.releases.push(release);
    this.audit.push({ at: this.now(), type: 'release_created', releaseId: release.id, order: release.order, slot });
    return release;
  }

  listReleases({ leg, active } = {}) {
    return this.releases.filter((release) => {
      if (leg && release.leg !== leg) return false;
      if (active && release.status === 'cancelled') return false;
      return true;
    });
  }

  signRelease(id, body = {}) {
    const release = this.releases.find((item) => item.id === id);
    if (!release) throw new DomainError(404, 'RELEASE_NOT_FOUND', `找不到释放记录 ${id}`);
    release.status = 'signed';
    release.signedBy = body.by ?? body.signedBy ?? release.signedBy ?? '值班员';
    release.signedAt = this.now();
    return release;
  }

  cancelRelease(id, body = {}) {
    const release = this.releases.find((item) => item.id === id);
    if (!release) throw new DomainError(404, 'RELEASE_NOT_FOUND', `找不到释放记录 ${id}`);
    release.status = 'cancelled';
    release.cancelledAt = this.now();
    release.cancelReason = body.reason ?? null;
    return release;
  }

  reconciliation({ leg } = {}) {
    const view = this.buildView();
    return {
      generatedAt: this.now(),
      leg: leg ?? null,
      ticketCounts: this.getOrders().map((order) => ({ order: order.order, leg: order.currentLeg, assets: order.assets, permission: order.permissionLabel })),
      rampCounts: {
        passages: view.ramp.passages.length,
        effectiveAssets: Object.values(view.ramp.assetStates).map((asset) => ({ asset: asset.asset, state: asset.state, last: asset.last })),
        gaps: view.ramp.gaps,
      },
      deckCounts: {
        slots: view.slots.map((slot) => ({ layer: slot.layer, slot: slot.slot, asset: slot.asset, status: slot.status, at: slot.at })),
        handoffs: this.handoffs.map((h) => ({ id: h.id, layer: h.layer, at: h.at, status: h.status })),
        coverage: view.coverage.boundaries,
      },
      releaseCandidates: this.evaluateRelease({ leg: leg ?? undefined }),
      unknownLocations: view.unknownLocations,
      findings: this.listFindings(),
    };
  }

  toJSON() {
    return {
      format: 'vehicle-deck-ledger@1',
      records: this.records,
      recordKeys: [...this.recordKeys],
      layouts: [...this.layouts.entries()],
      handoffs: this.handoffs,
      waitlist: this.waitlist,
      releases: this.releases,
      handling: [...this.handling.entries()],
      audit: this.audit,
      counters: this.counters,
      sourceStatus: [...this.sourceStatus.entries()],
    };
  }

  loadJSON(state = {}) {
    this.records = state.records ?? [];
    this.recordKeys = new Set(state.recordKeys ?? this.records.map((r) => r.record));
    this.layouts = new Map(state.layouts ?? []);
    this.handoffs = state.handoffs ?? [];
    this.waitlist = state.waitlist ?? [];
    this.releases = state.releases ?? [];
    this.handling = new Map(state.handling ?? []);
    this.audit = state.audit ?? [];
    this.counters = state.counters ?? { handoff: this.handoffs.length, waitlist: 0, release: 0, manual: 0 };
    this.sourceStatus = new Map(state.sourceStatus ?? []);
    return this;
  }
}
