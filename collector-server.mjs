import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DomainError, Ledger } from './lib/ledger.mjs';
import { collectSource } from './lib/source-client.mjs';

export function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError(400, 'INVALID_JSON', '请求体必须是 JSON');
  }
}

async function saveDb(dbPath, ledger) {
  if (!dbPath || dbPath === ':memory:') return;
  await mkdir(dirname(dbPath), { recursive: true });
  const temporary = `${dbPath}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger.toJSON(), null, 2), 'utf8');
  await rename(temporary, dbPath);
}

export async function startCollector(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT ?? 4200);
  const sourceUrl = options.sourceUrl ?? process.env.SOURCE_URL ?? 'http://127.0.0.1:4100';
  const dbPath = options.dbPath ?? process.env.LEDGER_DB ?? null;
  const ledger = options.ledger ?? new Ledger();
  if (dbPath && dbPath !== ':memory:' && !options.ledger) {
    try {
      ledger.loadJSON(JSON.parse(await readFile(dbPath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${host}:${port}`);
    const path = url.pathname;
    try {
      if (request.method === 'GET' && (path === '/' || path === '/health')) {
        sendJson(response, 200, {
          service: 'vehicle-deck-collector',
          ok: true,
          sourceUrl,
          endpoints: [
            'POST /collect', 'GET /reconciliation', 'GET /view', 'GET /unknown',
            'GET/POST /handoffs', 'GET /handoffs/:id/replay',
            'GET /findings', 'POST /findings/:key/acknowledge|assign|resolve',
            'GET /release-candidates?leg=', 'POST /releases', 'GET /releases',
          ],
        });
        return;
      }

      if (request.method === 'POST' && path === '/collect') {
        const body = await readBody(request);
        const result = await collectSource(ledger, {
          baseUrl: body.sourceUrl ?? url.searchParams.get('sourceUrl') ?? sourceUrl,
          stage: body.stage ?? (url.searchParams.has('stage') ? Number(url.searchParams.get('stage')) : undefined),
        });
        await saveDb(dbPath, ledger);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'GET' && path === '/sources/status') {
        sendJson(response, 200, { sources: [...ledger.sourceStatus.values()] });
        return;
      }

      if (request.method === 'GET' && path === '/orders') {
        sendJson(response, 200, { orders: ledger.getOrders({ at: url.searchParams.get('at') }) });
        return;
      }

      if (request.method === 'GET' && path === '/identities') {
        sendJson(response, 200, { identityMode: 'asset-token+passage-association', plates: ledger.getIdentityLabels() });
        return;
      }

      if (request.method === 'GET' && (path === '/view' || path === '/deck/view')) {
        sendJson(response, 200, ledger.buildView({
          at: url.searchParams.get('at'),
          layer: url.searchParams.get('layer'),
          leg: url.searchParams.get('leg'),
        }));
        return;
      }

      if (request.method === 'GET' && path === '/unknown') {
        const view = ledger.buildView({ layer: url.searchParams.get('layer'), at: url.searchParams.get('at') });
        sendJson(response, 200, { unknownLocations: view.unknownLocations, coverage: view.coverage, gaps: view.ramp.gaps });
        return;
      }

      if (request.method === 'GET' && path === '/reconciliation') {
        sendJson(response, 200, ledger.reconciliation({ leg: url.searchParams.get('leg') ?? undefined }));
        return;
      }

      if (request.method === 'POST' && path === '/layouts') {
        const body = await readBody(request);
        const result = ledger.configureLayout(body.layer, body.slots);
        await saveDb(dbPath, ledger);
        sendJson(response, 201, result);
        return;
      }

      if (request.method === 'POST' && path === '/records') {
        const body = await readBody(request);
        const record = body.record && body.payload ? body : { record: body.recordKey, kind: body.kind, payload: body.payload ?? body };
        const result = ledger.ingest(record, { manual: true });
        ledger.reconcileFindings();
        await saveDb(dbPath, ledger);
        sendJson(response, result.duplicate ? 200 : 201, result);
        return;
      }

      if (request.method === 'POST' && path === '/readings') {
        const body = await readBody(request);
        const payload = body.payload ?? body;
        const result = ledger.ingest({ record: body.record, kind: 'scan', availableFrom: body.availableFrom, payload }, { manual: true });
        await saveDb(dbPath, ledger);
        sendJson(response, result.duplicate ? 200 : 201, result);
        return;
      }

      if (request.method === 'POST' && path === '/deck-events') {
        const body = await readBody(request);
        const payload = body.payload ?? body;
        const result = ledger.ingest({ record: body.record, kind: body.kind ?? payload.kind, payload }, { manual: true });
        await saveDb(dbPath, ledger);
        sendJson(response, result.duplicate ? 200 : 201, result);
        return;
      }

      if (request.method === 'GET' && path === '/handoffs') {
        sendJson(response, 200, { handoffs: ledger.listHandoffs() });
        return;
      }
      if (request.method === 'POST' && path === '/handoffs') {
        const body = await readBody(request);
        const handoff = ledger.createHandoff(body);
        await saveDb(dbPath, ledger);
        sendJson(response, 201, ledger.replayHandoff(handoff.id));
        return;
      }

      let match = /^\/handoffs\/([^/]+)\/replay$/.exec(path);
      if (request.method === 'GET' && match) {
        sendJson(response, 200, ledger.replayHandoff(decodeURIComponent(match[1])));
        return;
      }
      match = /^\/handoffs\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && match) {
        sendJson(response, 200, ledger.getHandoff(decodeURIComponent(match[1])));
        return;
      }

      if (request.method === 'GET' && path === '/findings') {
        sendJson(response, 200, { findings: ledger.listFindings({ status: url.searchParams.get('status') ?? undefined }) });
        return;
      }
      match = /^\/findings\/([^/]+)\/(acknowledge|assign|resolve)$/.exec(path);
      if (request.method === 'POST' && match) {
        const body = await readBody(request);
        const finding = ledger.actOnFinding(decodeURIComponent(match[1]), match[2], body);
        await saveDb(dbPath, ledger);
        sendJson(response, 200, finding);
        return;
      }
      match = /^\/findings\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && match) {
        sendJson(response, 200, ledger.getFinding(decodeURIComponent(match[1])));
        return;
      }

      if (request.method === 'GET' && path === '/waitlist') {
        sendJson(response, 200, { waitlist: ledger.listWaitlist({ leg: url.searchParams.get('leg') }) });
        return;
      }
      if (request.method === 'POST' && path === '/waitlist') {
        const body = await readBody(request);
        const entry = ledger.addWaitlist(body);
        await saveDb(dbPath, ledger);
        sendJson(response, 201, entry);
        return;
      }

      if (request.method === 'GET' && path === '/release-candidates') {
        const leg = url.searchParams.get('leg');
        if (!leg) throw new DomainError(400, 'LEG_REQUIRED', '必须提供 leg 查询参数');
        sendJson(response, 200, { leg, candidates: ledger.evaluateRelease({ leg, order: url.searchParams.get('order') ?? undefined }) });
        return;
      }

      if (request.method === 'GET' && path === '/releases') {
        sendJson(response, 200, { releases: ledger.listReleases({ leg: url.searchParams.get('leg'), active: url.searchParams.get('active') === '1' }) });
        return;
      }
      if (request.method === 'POST' && path === '/releases') {
        const body = await readBody(request);
        const release = ledger.createRelease(body);
        await saveDb(dbPath, ledger);
        sendJson(response, 201, release);
        return;
      }
      match = /^\/releases\/([^/]+)\/sign$/.exec(path);
      if (request.method === 'POST' && match) {
        const body = await readBody(request);
        const release = ledger.signRelease(decodeURIComponent(match[1]), body);
        await saveDb(dbPath, ledger);
        sendJson(response, 200, release);
        return;
      }
      match = /^\/releases\/([^/]+)\/cancel$/.exec(path);
      if (request.method === 'POST' && match) {
        const body = await readBody(request);
        const release = ledger.cancelRelease(decodeURIComponent(match[1]), body);
        await saveDb(dbPath, ledger);
        sendJson(response, 200, release);
        return;
      }

      if (request.method === 'POST' && path === '/admin/reset' && options.allowReset) {
        ledger.loadJSON({});
        await saveDb(dbPath, ledger);
        sendJson(response, 200, { reset: true });
        return;
      }

      sendJson(response, 404, { error: '未找到采集服务路由', path });
    } catch (error) {
      if (error instanceof DomainError) {
        sendJson(response, error.status, { error: error.message, code: error.code, details: error.details });
      } else {
        sendJson(response, 500, { error: '采集服务处理失败', detail: error?.message ?? String(error) });
      }
    }
  });

  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  return { server, ledger, url: `http://${host}:${address.port}`, dbPath: dbPath ?? null };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dbPath = process.env.LEDGER_DB === undefined
    ? fileURLToPath(new URL('./data/ledger-state.json', import.meta.url))
    : process.env.LEDGER_DB;
  const app = await startCollector({
    port: Number(process.env.PORT ?? 4200),
    allowReset: process.env.ALLOW_RESET === '1',
    dbPath,
  });
  console.log(`车辆甲板采集服务 ${app.url}`);
  console.log(`状态持久化 ${dbPath || '内存（设置 LEDGER_DB 可持久化）'}`);
  console.log(`默认来源 ${process.env.SOURCE_URL ?? 'http://127.0.0.1:4100'}；POST /collect 开始采集`);
  if (process.env.AUTO_COLLECT === '1') {
    collectSource(app.ledger, { baseUrl: process.env.SOURCE_URL }).then(
      (result) => console.log(`自动采集完成，来源阶段 ${result.stage}`),
      (error) => console.warn(`自动采集未完成：${error.message}`),
    );
  }
}
