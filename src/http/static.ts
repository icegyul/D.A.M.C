import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Resolve the dashboard directory for both layouts:
//   dev  — src/http/static.ts        -> <project>/web
//   built— dist/src/http/static.js   -> <project>/web
const candidates = [
  path.resolve(here, '../../web'),
  path.resolve(here, '../../../web')
];
const webRoot = candidates.find(dir => existsSync(path.join(dir, 'index.html'))) ?? candidates[0]!;

export async function registerStatic(app: FastifyInstance) {
  if (!existsSync(path.join(webRoot, 'index.html'))) {
    app.log.warn({ webRoot, candidates }, 'DAMC dashboard assets not found; only the API will be served.');
    return;
  }
  await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
  app.get('/', async (_req, reply) => reply.sendFile('index.html'));
}
