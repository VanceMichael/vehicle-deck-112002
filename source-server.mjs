import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const here = new URL('./', import.meta.url);
const fixtures = new URL('source-data/', here);
const files = new URL('originals/', here);
const index = JSON.parse(await readFile(new URL('index.json', fixtures), 'utf8'));

export function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function start({ port = 0, host = '127.0.0.1', portal } = {}) {
  const sources = new Map();
  for (const name of index.sources) {
    sources.set(name, JSON.parse(await readFile(new URL(name + '.json', fixtures), 'utf8')));
  }
  let stage = 1;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/control' && request.method === 'POST') {
        const value = Number(url.searchParams.get('stage'));
        if (!Number.isInteger(value) || value < 1 || value > index.stages) {
          sendJson(response, 400, { error: '回放阶段无效' });
          return;
        }
        stage = value;
        sendJson(response, 200, { stage });
        return;
      }
      if (portal && await portal(request, response, url, stage)) return;
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: '来源仅支持读取' });
        return;
      }
      if (url.pathname === '/') {
        sendJson(response, 200, { stage, sources: [...sources.keys()], stages: index.stages });
        return;
      }
      const source = /^\/source\/([a-z]+)$/.exec(url.pathname);
      if (source && sources.has(source[1])) {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 3);
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          sendJson(response, 400, { error: '分页参数无效' });
          return;
        }
        const visible = sources.get(source[1]).filter((entry) => entry.availableFrom <= stage);
        sendJson(response, 200, {
          records: visible.slice(offset, offset + limit),
          next: offset + limit < visible.length ? offset + limit : null,
          stage,
        });
        return;
      }
      const asset = /^\/original\/([a-zA-Z0-9_.-]+)$/.exec(url.pathname);
      if (asset && index.originals.includes(asset[1])) {
        const available = index.originalStages[asset[1]] ?? 1;
        if (stage < available) {
          sendJson(response, 404, { error: '本轮暂未提供此原件' });
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.end(await readFile(new URL(asset[1], files)));
        return;
      }
      sendJson(response, 404, { error: '未找到来源' });
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: '来源回放失败' });
      else response.destroy();
    }
  });
  server.listen(port, host);
  await once(server, 'listening');
  return { server, url: `http://${host}:${server.address().port}` };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const options = { port: Number(process.env.PORT ?? 4100) };
  let portal;
  if (index.portal) {
    const { makePortal } = await import('./portal.mjs');
    portal = makePortal();
  }
  const app = await start({ ...options, portal });
  console.log(`来源服务 ${app.url}`);
}
