// 采集服务 HTTP 接口：除来源采集外，还承接值班员的交班确认、带未清项交班与差异签收。
// 所有写操作都落为本地事件，随后重放 derive 得到当前视图。
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { EventStore } from './event-store.mjs';
import { Collector } from './collector.mjs';
import { derive } from './reconcile.mjs';

export async function start({ port = 0, host = '127.0.0.1', dataDir = null, sourceUrl, autoPollMs = 0 } = {}) {
  const store = new EventStore({ dir: dataDir });
  await store.init();
  const collector = sourceUrl ? new Collector({ baseUrl: sourceUrl, store }) : null;
  if (collector && autoPollMs > 0) collector.start(autoPollMs);

  const send = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);
    try {
      if (request.method === 'POST' && p === '/collect') {
        if (!collector) return send(response, 400, { error: '未配置来源地址' });
        return send(response, 200, await collector.collectOnce());
      }
      if (request.method === 'POST' && p === '/source-stage') {
        if (!collector) return send(response, 400, { error: '未配置来源地址' });
        const stage = Number(url.searchParams.get('stage'));
        return send(response, 200, await collector.setStage(stage));
      }
      if (request.method === 'GET' && p === '/events') {
        return send(response, 200, { count: store.events.length, events: store.events });
      }
      if (request.method === 'GET' && p === '/reconcile') {
        return send(response, 200, derive(store.events));
      }
      if (request.method === 'GET' && /^\/reconcile\/order\/[^/]+$/.test(p)) {
        const order = p.split('/').pop();
        const result = derive(store.events).orders.find((o) => o.order === order);
        return result ? send(response, 200, result) : send(response, 404, { error: '过渡单不存在' });
      }
      if (request.method === 'GET' && /^\/reconcile\/asset\/[^/]+$/.test(p)) {
        const asset = p.split('/').pop();
        const view = derive(store.events);
        const movements = view.movements.filter((m) => m.asset === asset);
        if (!movements.length) return send(response, 404, { error: '实物无任何通行或甲板记录' });
        return send(response, 200, { asset, movements, relatedOrders: view.orders.filter((o) => o.assets.some((a) => a.asset === asset)) });
      }
      if (request.method === 'GET' && /^\/reconcile\/deck\/[^/]+\/[^/]+$/.test(p)) {
        const parts = p.split('/');
        const [, , , leg, layer] = parts;
        const found = derive(store.events).deck.layers.find((l) => l.leg === leg && l.layer === layer);
        return found ? send(response, 200, found) : send(response, 404, { error: '该航次/甲板暂无材料' });
      }
      if (request.method === 'GET' && p === '/handovers') {
        return send(response, 200, { handovers: derive(store.events).handovers });
      }
      if (request.method === 'GET' && p === '/discrepancies') {
        const view = derive(store.events);
        return send(response, 200, {
          discrepancies: view.handovers.filter((h) => h.status === '已被补录推翻'),
          conflicts: view.conflicts,
        });
      }
      if (request.method === 'GET' && p === '/unknown') {
        return send(response, 200, derive(store.events).unknown);
      }
      // 值班员对明确的甲板提交交班确认；unchecked 即带着未清项交班
      if (request.method === 'POST' && p === '/handovers') {
        const body = await readBody(request);
        const { id, leg, layer, time, seen, unchecked } = body;
        if (!id || !leg || !layer || !time || typeof seen !== 'object') {
          return send(response, 400, { error: '交班确认需要 id、leg、layer、time 和 seen' });
        }
        const payload = { id, leg, layer, time, seen, unchecked: Array.isArray(unchecked) ? unchecked : [] };
        await store.addLocal('signoff', payload);
        return send(response, 201, { accepted: true, handover: derive(store.events).handovers.find((h) => h.id === id) });
      }
      // 下一班签收补录产生的差异：原结论、差异实物、处理责任一并留档
      if (request.method === 'POST' && /^\/discrepancies\/[^/]+\/ack$/.test(p)) {        const discrepancyId = p.split('/')[2];
        const body = await readBody(request);
        const view = derive(store.events);
        const handover = view.handovers.find((h) => h.discrepancyId === discrepancyId);
        if (!handover) return send(response, 404, { error: '差异编号不存在' });
        if (handover.acknowledged) return send(response, 409, { error: '该差异已由下一班签收' });
        await store.addLocal('ack-discrepancy', {
          discrepancyId,
          handoverId: handover.id,
          by: body.by ?? null,
          time: body.time ?? null,
          responsibility: body.responsibility ?? '下一班核实并处理',
          differences: handover.differences,
        });
        return send(response, 201, { accepted: true, handover: derive(store.events).handovers.find((h) => h.id === handover.id) });
      }
      if (request.method === 'GET' && p === '/health') {
        return send(response, 200, {
          ok: true,
          events: store.events.length,
          source: collector ? collector.baseUrl : null,
          lastStage: collector?.lastStage ?? null,
          lastError: collector?.lastError ?? null,
        });
      }
      return send(response, 404, { error: '未找到接口' });
    } catch (error) {
      if (!response.headersSent) send(response, 500, { error: `服务处理失败：${error.message}` });
      else response.destroy();
    }
  });

  server.listen(port, host);
  await once(server, 'listening');
  return {
    server,
    store,
    collector,
    url: `http://${host}:${server.address().port}`,
    reconcile: () => derive(store.events),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const app = await start({
    port: Number(process.env.PORT ?? 4200),
    dataDir: process.env.DATA_DIR ?? './data',
    sourceUrl: process.env.SOURCE_URL ?? 'http://127.0.0.1:4100',
    autoPollMs: Number(process.env.POLL_MS ?? 2000),
  });
  console.log(`采集服务 ${app.url}`);
}
