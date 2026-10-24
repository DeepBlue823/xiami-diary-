import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = await readFile(new URL('../api/pet-quote.js', import.meta.url), 'utf8');

async function setup(options = {}) {
  const calls = { fetch: 0, limits: [], writes: [], cleared: 0 };
  const redis = {
    get: options.get || (async () => null),
    set: options.set || (async (...args) => calls.writes.push(args))
  };
  const context = vm.createContext({
    process: { env: { DEEPSEEK_API_KEY: 'test-key', ...options.env } },
    console: { warn() {} },
    AbortController,
    setTimeout(callback, duration) {
      assert.equal(duration, 6000);
      if (options.timeout) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() { calls.cleared++; },
    fetch: async (...args) => {
      calls.fetch++;
      if (options.fetch) return options.fetch(...args);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '我把今天的小心情都交给小比格保管。' } }] }) };
    }
  });
  const helper = new vm.SyntheticModule(['getRedis', 'rateLimit', 'handleError'], function () {
    this.setExport('getRedis', () => {
      if (options.redisError) throw options.redisError;
      return redis;
    });
    this.setExport('rateLimit', async (...args) => {
      calls.limits.push(args.slice(2));
      if (options.limitError) throw options.limitError;
    });
    this.setExport('handleError', (res, error) => res.status(error.status || 500).json({ error: '服务暂不可用' }));
  }, { context });
  const cryptoModule = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', crypto);
  }, { context });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => specifier === 'crypto' ? cryptoModule : helper);
  await module.evaluate();
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  const req = { method: 'POST', body: { petType: 'cat', diaries: [{ id: 1, title: '今天', content: '一起散步。' }] } };
  return { calls, req, res, run: () => module.namespace.default(req, res) };
}

test('quote endpoint rejects unsupported methods and empty diary context before remote work', async () => {
  const env = await setup();
  env.req.method = 'GET';
  await env.run();
  assert.equal(env.res.statusCode, 405);
  assert.equal(env.res.headers.Allow, 'POST');
  env.req.method = 'POST';
  env.req.body.diaries = [null, {}];
  await env.run();
  assert.equal(env.res.statusCode, 400);
  assert.equal(env.calls.fetch, 0);
});

test('cached quotes remain available without generation credentials or quota', async () => {
  const env = await setup({ get: async () => '缓存的语录。', env: { DEEPSEEK_API_KEY: '' } });
  await env.run();
  assert.equal(env.res.body.quote, '缓存的语录。');
  assert.equal(env.res.body.cached, true);
  assert.equal(env.calls.fetch, 0);
  assert.equal(env.calls.limits.length, 0);
  assert.equal(env.res.headers['Cache-Control'], 'no-store');
});

test('fresh generation applies visitor and global quotas, then caches for one day', async () => {
  const env = await setup();
  await env.run();
  assert.equal(env.res.statusCode, 200);
  assert.equal(env.res.body.cached, false);
  assert.equal(env.calls.fetch, 1);
  assert.equal(env.calls.limits.length, 2);
  assert.equal(env.calls.limits[0][1], 30);
  assert.equal(env.calls.limits[1][1], 100);
  assert.equal(env.calls.limits[1][3].global, true);
  assert.equal(env.calls.writes[0][2], 'EX');
  assert.equal(env.calls.writes[0][3], 86400);
  assert.equal(env.calls.cleared, 1);
});

test('cache failures do not discard a generated quote when quota checks succeed', async () => {
  const env = await setup({
    get: async () => { throw new Error('read failure'); },
    set: async () => { throw new Error('write failure'); }
  });
  await env.run();
  assert.equal(env.res.statusCode, 200);
  assert.ok(env.res.body.quote);
  assert.equal(env.calls.limits.length, 2);
});

test('quota and Redis failures stop paid generation', async () => {
  for (const status of [429, 503]) {
    const env = await setup({ limitError: Object.assign(new Error('private detail'), { status }) });
    await env.run();
    assert.equal(env.res.statusCode, status);
    assert.equal(env.calls.fetch, 0);
  }
  const env = await setup({ redisError: Object.assign(new Error('missing config'), { status: 503 }) });
  await env.run();
  assert.equal(env.res.statusCode, 503);
  assert.equal(env.calls.fetch, 0);
});

test('upstream errors and invalid responses return generic errors without leaking details', async () => {
  const cases = [
    async () => { throw new Error('private connection detail'); },
    async () => ({ ok: false, text: async () => 'private service detail' }),
    async () => ({ ok: true, json: async () => { throw new Error('private parse detail'); } }),
    async () => ({ ok: true, json: async () => null }),
    async () => ({ ok: true, json: async () => ({ choices: [] }) }),
    async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: {} } }] }) })
  ];
  for (const fetch of cases) {
    const env = await setup({ fetch });
    await env.run();
    assert.equal(env.res.statusCode, 502);
    assert.equal(env.res.body.detail, undefined);
    assert.equal(JSON.stringify(env.res.body).includes('private'), false);
    assert.equal(env.calls.writes.length, 0);
    assert.equal(env.calls.cleared, 1);
  }
});

test('generation timeout aborts the upstream request and returns 504', async () => {
  const env = await setup({
    timeout: true,
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });
  await env.run();
  assert.equal(env.res.statusCode, 504);
  assert.equal(env.calls.cleared, 1);
  assert.equal(env.calls.writes.length, 0);
});
