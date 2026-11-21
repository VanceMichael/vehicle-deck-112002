// 采集器：分页轮询三个来源，按来源记录键去重后追加到事件日志。
// 回卷与修订由来源的回放阶段驱动：同 station/seq 的更高 rev 会作为新记录到达，
// 核对引擎重放时自动以最高 rev 为准；floor 记录则把更早序列标为不可补缺口。
import { EventStore } from './event-store.mjs';

const SOURCES = ['booking', 'ramp', 'deck'];

export class Collector {
  constructor({ baseUrl, store, pageLimit = 100, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.store = store instanceof EventStore ? store : new EventStore({ dir: store });
    this.pageLimit = pageLimit;
    this.fetch = fetchImpl;
    this.lastStage = null;
    this.history = [];
  }

  async setStage(stage) {
    const response = await this.fetch(`${this.baseUrl}/control?stage=${stage}`, { method: 'POST' });
    if (!response.ok) throw new Error(`切换回放阶段失败：${response.status} ${await response.text()}`);
    const body = await response.json();
    this.lastStage = body.stage;
    return body;
  }

  async getStage() {
    const response = await this.fetch(this.baseUrl);
    if (!response.ok) throw new Error(`读取来源根路径失败：${response.status}`);
    const body = await response.json();
    this.lastStage = body.stage;
    return body;
  }

  async pullSource(name) {
    const added = [];
    let offset = 0;
    do {
      const url = `${this.baseUrl}/source/${name}?offset=${offset}&limit=${this.pageLimit}`;
      const response = await this.fetch(url);
      if (!response.ok) throw new Error(`采集 ${name} 失败：${response.status} ${await response.text()}`);
      const page = await response.json();
      for (const record of page.records) {
        const isNew = await this.store.add(record, { source: name, stage: page.stage });
        if (isNew) added.push(record.record);
      }
      offset = page.next;
    } while (offset !== null);
    return added;
  }

  async collectOnce() {
    const overview = await this.getStage();
    const result = { stage: overview.stage, sources: {} };
    for (const name of SOURCES) {
      result.sources[name] = await this.pullSource(name);
    }
    this.history.push({ at: new Date().toISOString(), ...result });
    return result;
  }

  start(intervalMs = 2000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.collectOnce().catch((error) => {
        this.lastError = { at: new Date().toISOString(), message: error.message };
      });
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
