// 追加式事件日志：来源记录与本地操作都只追加，状态全部由重放得到。
// 这样迟到的修订（坡道 rev）、跨交班时刻的补录都可以通过重算同一批事件得到新视图。
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

let localSeq = 0;

function normalize(record, source, stage) {
  const payload = record.payload ?? {};
  return {
    key: record.record ?? record.key,
    source,
    kind: record.kind,
    stage: stage ?? record.availableFrom ?? null,
    time: payload.time ?? null,
    station: payload.station ?? null,
    seq: payload.seq ?? null,
    rev: payload.rev ?? null,
    payload,
  };
}

export class EventStore {
  constructor({ dir = null } = {}) {
    this.dir = dir;
    this.file = dir ? join(dir, 'events.jsonl') : null;
    this.events = [];
    this.keys = new Set();
  }

  async init() {
    if (!this.file) return;
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.file)) return;
    const text = await readFile(this.file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      this.events.push(event);
      this.keys.add(event.key);
      const n = Number((/^local-\w+-(\d+)$/.exec(event.key) ?? [])[1] ?? 0);
      localSeq = Math.max(localSeq, n);
    }
  }

  async add(record, { source = 'unknown', stage } = {}) {
    const event = normalize(record, source, stage);
    if (this.keys.has(event.key)) return false;
    this.keys.add(event.key);
    this.events.push(event);
    if (this.file) await appendFile(this.file, `${JSON.stringify(event)}\n`);
    return true;
  }

  // 值班员在本服务内提交的操作同样落为事件，保证重启后可重放。
  async addLocal(kind, payload, { source = 'local', stage = null } = {}) {
    localSeq += 1;
    const record = { record: `local-${kind}-${localSeq}`, kind, payload };
    return this.add(record, { source, stage });
  }
}
