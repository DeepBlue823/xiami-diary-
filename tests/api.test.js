import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as crypto from 'node:crypto';

const sources = Object.fromEntries(await Promise.all(['lib/server.js', 'api/auth.js', 'api/diaries.js'].map(async path => [
  path, await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
])));

async function setup(options = {}) {
  const db = new Map(Object.entries(options.data || {}));
  const state = { writes: [], conflicts: 0, failRedis: false };
  const checkConnection = () => {
    if (state.failRedis) throw new Error('private redis://secret-password@internal-host:6379');
  };
  class FakeRedis {
    constructor() { this.status = 'ready'; }
    on() {}
    async get(key) { checkConnection(); return db.get(key) ?? null; }
    async set(key, value, ...args) {
      checkConnection();
      state.writes.push({ key, value, args });
      db.set(key, String(value));
      return 'OK';
    }
    async del(key) { checkConnection(); return db.delete(key) ? 1 : 0; }
    async eval(script, keyCount, ...args) {
      checkConnection();
      const keys = args.slice(0, keyCount);
      const values = args.slice(keyCount);
      if (state.beforeEval) await state.beforeEval(keys);
      if (script.includes("redis.call('INCR'")) {
        const count = Number(db.get(keys[0]) || 0) + 1;
        db.set(keys[0], String(count));
        return count;
      }
      if (script.includes("redis.call('GET'")) {
        if (values[3] && (db.get(keys[keys.length - 1]) ?? null) !== values[3]) return -1;
        const current = db.get(keys[0]) ?? null;
        if ((current === null && values[0] === 'missing') ||
            (current !== null && values[0] === 'present' && current === values[1])) {
          db.set(keys[0], values[2]);
          if (values[4] === 'delete') db.delete(keys[1]);
          return 1;
        }
        state.conflicts++;
        return 0;
      }
      throw new Error('Test Redis does not recognize this Lua script');
    }
  }
  const password = 'a-long-private-admin-password';
  const context = vm.createContext({ process: { env: { REDIS_URL: 'redis://test', ADMIN_PASSWORD: password, ...options.env } } });
  const redisModule = new vm.SyntheticModule(['default'], function () { this.setExport('default', FakeRedis); }, { context });
  const cryptoModule = new vm.SyntheticModule(Object.keys(crypto), function () {
    for (const [key, value] of Object.entries(crypto)) this.setExport(key, value);
  }, { context });
  const helper = new vm.SourceTextModule(sources['lib/server.js'], { context });
  await helper.link(specifier => specifier === 'ioredis' ? redisModule : cryptoModule);
  await helper.evaluate();
  const handlers = {};
  for (const file of ['auth', 'diaries']) {
    const module = new vm.SourceTextModule(sources[`api/${file}.js`], { context });
    await module.link(specifier => specifier === 'node:crypto' ? cryptoModule : helper);
    await module.evaluate();
    handlers[file] = module.namespace.default;
  }
  async function request(endpoint, { method = 'GET', body, token, headers = {}, query = {}, address = '127.0.0.1' } = {}) {
    const res = {
      statusCode: 200, headers: {}, body: undefined,
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; }
    };
    await handlers[endpoint]({ method, body, query, socket: { remoteAddress: address },
      headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res);
    return res;
  }
  async function login() {
    const result = await request('auth', { method: 'POST', body: { password } });
    assert.equal(result.statusCode, 200);
    return result.body.token;
  }
  return { db, state, password, request, login, helper: helper.namespace };
}

const diary = (id, content = '今天一起散步。') => ({ id, title: '今天', content, date: '2026-10-24T00:00:00.000Z' });

test('login returns opaque random tokens, stores a seven-day session, and supports validation and logout', async () => {
  const env = await setup();
  const token = await env.login();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(token.includes(env.password), false);
  assert.equal(Buffer.from(token, 'base64').toString().includes(env.password), false);
  const session = env.state.writes.find(entry => entry.key === `auth:${token}`);
  assert.deepEqual(session, { key: `auth:${token}`, value: 'true', args: ['EX', 604800] });
  const secondToken = await env.login();
  assert.notEqual(token, secondToken);
  const validated = await env.request('auth', { token });
  assert.equal(validated.statusCode, 200);
  assert.equal(validated.headers['Cache-Control'], 'no-store');
  assert.equal((await env.request('auth', { method: 'DELETE', token })).statusCode, 200);
  assert.equal(env.db.has(`auth:${token}`), false);
  assert.equal((await env.request('auth', { token })).statusCode, 401);
  assert.equal((await env.request('auth', { token: secondToken })).statusCode, 200);
});

test('legacy, fabricated and malformed credentials cannot authenticate or write', async () => {
  const env = await setup();
  const legacy = Buffer.from(`${env.password}:12345678`).toString('base64');
  env.db.set(`auth:${legacy}`, 'true');
  for (const token of [undefined, legacy, 'a'.repeat(64), 'bad-token']) {
    assert.equal((await env.request('auth', { token })).statusCode, 401);
    assert.equal((await env.request('diaries', { method: 'POST', token, body: { content: 'unauthorized' } })).statusCode, 401);
  }
  assert.equal(env.db.has('diaries'), false);
});

test('login attempts are rate limited and a spoofable forwarded-for header does not reset quota', async () => {
  const env = await setup();
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await env.request('auth', { method: 'POST', body: { password: 'wrong' }, headers: { 'x-forwarded-for': `forged-${attempt}` } });
    assert.equal(response.statusCode, 401);
    assert.equal(JSON.stringify(response.body).includes(env.password), false);
  }
  assert.equal((await env.request('auth', { method: 'POST', body: { password: env.password } })).statusCode, 429);
  assert.equal((await env.request('auth', { method: 'POST', body: { password: env.password }, address: '127.0.0.2' })).statusCode, 200);
});

test('malformed and empty bodies, unsupported methods, and unknown actions are rejected', async () => {
  const env = await setup();
  for (const endpoint of ['auth', 'diaries']) {
    for (const body of [undefined, null, [], '{bad-json', 1, true]) {
      assert.equal((await env.request(endpoint, { method: 'POST', body })).statusCode, 400);
    }
    const unsupported = await env.request(endpoint, { method: 'PATCH' });
    assert.equal(unsupported.statusCode, 405);
    assert.equal(unsupported.headers.Allow, 'GET, POST, DELETE');
  }
  for (const password of [undefined, '', [], {}, 23, 'x'.repeat(1025)]) {
    assert.equal((await env.request('auth', { method: 'POST', body: { password } })).statusCode, 400);
  }
  assert.equal((await env.request('diaries', { query: { action: 'unexpected' } })).statusCode, 400);
  assert.equal((await env.request('diaries', { method: 'POST', body: { action: 'unexpected' } })).statusCode, 400);
  assert.equal((await env.request('diaries', { method: 'DELETE', body: { action: 'addComment' } })).statusCode, 400);
  const login = await env.request('auth', { method: 'POST', body: JSON.stringify({ password: env.password }) });
  assert.equal(login.statusCode, 200);
});

test('diary fields, identifiers, and meeting dates validate before storage', async () => {
  const env = await setup();
  const token = await env.login();
  for (const body of [
    {}, { title: {} }, { content: [] }, { content: 'x', mood: 'unexpected' },
    { content: 'x', girlfriendLocation: {} }, { content: 'x', id: 'invalid' },
    { content: 'x', date: '2026-02-30' }, { content: 'x', date: '2026-13-01' },
    { content: 'x', date: true }, { content: 'x', date: 0 }, { content: 'x', date: false },
    { title: 'x'.repeat(201) }, { content: 'x'.repeat(100001) },
    { action: 'addMeeting', startDate: '2026-10-25', endDate: '2026-10-24' },
    { action: 'addMeeting', startDate: '2026-02-30', endDate: '2026-03-01' }
  ]) {
    assert.equal((await env.request('diaries', { method: 'POST', token, body })).statusCode, 400, JSON.stringify(body).slice(0, 160));
  }
  assert.equal((await env.request('diaries', { method: 'POST', token, body: { id: 123, content: 'missing diary' } })).statusCode, 404);
  assert.equal((await env.request('diaries', { query: { action: 'comments', diaryId: '../bad' } })).statusCode, 400);
  assert.equal(env.db.has('diaries'), false);
});

test('public reads and authenticated diary updates retain the API response format', async () => {
  const env = await setup();
  assert.deepEqual((await env.request('diaries')).body, []);
  const token = await env.login();
  const created = await env.request('diaries', { method: 'POST', token, body: { title: ' 小咪 ', content: ' 正文 ', date: '2026-10-24', mood: 'love' } });
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.diary.title, '小咪');
  assert.equal(created.body.diary.date, '2026-10-24T00:00:00.000Z');
  const id = created.body.diary.id;
  const edited = await env.request('diaries', { method: 'POST', token, body: { id, title: '更新', content: '更新正文', mood: 'happy' } });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.body.diary.id, id);
  assert.equal(edited.body.diary.date, created.body.diary.date);
  const read = await env.request('diaries');
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.length, 1);
  assert.equal(read.body[0].content, '更新正文');
  assert.equal(read.headers['Cache-Control'], 'no-store');
  const meeting = await env.request('diaries', { method: 'POST', token, body: { action: 'addMeeting', startDate: '2026-10-24', endDate: '2026-10-25' } });
  assert.equal(meeting.statusCode, 200);
  assert.equal((await env.request('diaries', { query: { action: 'meetings' } })).body.length, 1);
  assert.equal((await env.request('diaries', { method: 'POST', token, body: { action: 'deleteMeeting', id: meeting.body.meeting.id } })).statusCode, 400);
  assert.equal((await env.request('diaries', { method: 'DELETE', token, body: { action: 'deleteMeeting', id: meeting.body.meeting.id } })).statusCode, 200);
  assert.deepEqual((await env.request('diaries', { query: { action: 'meetings' } })).body, []);
});

test('comments cannot impersonate the administrator and public comment input is validated', async () => {
  const env = await setup({ data: { diaries: JSON.stringify([diary(1)]) } });
  const comment = { action: 'addComment', diaryId: 1, content: '想你啦' };
  for (const user of ['boyfriend', 'me']) {
    assert.equal((await env.request('diaries', { method: 'POST', body: { ...comment, user } })).statusCode, 401);
  }
  for (const fields of [{ user: 'administrator' }, { content: '' }, { content: {} }, { emoji: {} }, { diaryId: -1 }]) {
    assert.equal((await env.request('diaries', { method: 'POST', body: { ...comment, ...fields } })).statusCode, 400);
  }
  assert.equal((await env.request('diaries', { method: 'POST', body: { ...comment, diaryId: 2 } })).statusCode, 404);
  const publicComment = await env.request('diaries', { method: 'POST', body: comment });
  assert.equal(publicComment.statusCode, 200);
  assert.equal(publicComment.body.comment.user, 'girlfriend');
  const token = await env.login();
  const adminComment = await env.request('diaries', { method: 'POST', token, body: { ...comment, user: 'me' } });
  assert.equal(adminComment.statusCode, 200);
  assert.equal(adminComment.body.comment.user, 'boyfriend');
  assert.equal((await env.request('diaries', { method: 'DELETE', body: { action: 'deleteComment', diaryId: 1, commentId: publicComment.body.comment.id } })).statusCode, 401);
  assert.equal((await env.request('diaries', { method: 'DELETE', token, body: { action: 'deleteComment', diaryId: 1, commentId: publicComment.body.comment.id } })).statusCode, 200);
  assert.equal(JSON.parse(env.db.get('comments:1')).length, 1);
});

test('public comment flooding is limited', async () => {
  const env = await setup({ data: { diaries: JSON.stringify([diary(1)]) } });
  const body = { action: 'addComment', diaryId: 1, content: '一条评论' };
  for (let index = 0; index < 20; index++) {
    assert.equal((await env.request('diaries', { method: 'POST', body })).statusCode, 200);
  }
  assert.equal((await env.request('diaries', { method: 'POST', body })).statusCode, 429);
  assert.equal(JSON.parse(env.db.get('comments:1')).length, 20);
});

test('concurrent diary and comment writes use compare-and-set without dropping entries', async () => {
  const env = await setup();
  const token = await env.login();
  const created = await Promise.all(Array.from({ length: 6 }, (_, index) => env.request('diaries', {
    method: 'POST', token, body: { content: `日记 ${index}` }
  })));
  assert.ok(created.every(response => response.statusCode === 200));
  const diaries = JSON.parse(env.db.get('diaries'));
  assert.equal(diaries.length, 6);
  assert.equal(new Set(diaries.map(value => value.id)).size, 6);
  const comments = await Promise.all(Array.from({ length: 6 }, (_, index) => env.request('diaries', {
    method: 'POST', body: { action: 'addComment', diaryId: diaries[0].id, content: `评论 ${index}` }
  })));
  assert.ok(comments.every(response => response.statusCode === 200));
  const storedComments = JSON.parse(env.db.get(`comments:${diaries[0].id}`));
  assert.equal(storedComments.length, 6);
  assert.equal(new Set(storedComments.map(value => value.content)).size, 6);
  assert.ok(env.state.conflicts > 0, 'Concurrent requests must actually exercise CAS retry behavior');
});

test('diary deletion atomically removes its comments and preserves unrelated data', async () => {
  const env = await setup({ data: {
    diaries: JSON.stringify([diary(1), diary(2)]),
    'comments:1': JSON.stringify([{ id: 10 }]), 'comments:2': JSON.stringify([{ id: 20 }])
  } });
  const token = await env.login();
  assert.equal((await env.request('diaries', { method: 'DELETE', token, body: { id: 1 } })).statusCode, 200);
  assert.deepEqual(JSON.parse(env.db.get('diaries')).map(value => value.id), [2]);
  assert.equal(env.db.has('comments:1'), false);
  assert.equal(env.db.has('comments:2'), true);
});

test('Redis, configuration and stored-data failures return generic errors', async () => {
  const env = await setup();
  env.state.failRedis = true;
  for (const endpoint of ['auth', 'diaries']) {
    const response = await env.request(endpoint, endpoint === 'auth' ? { method: 'POST', body: { password: env.password } } : {});
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.stringify(response.body).includes('secret-password'), false);
    assert.equal(JSON.stringify(response.body).includes('internal-host'), false);
  }
  for (const raw of ['{bad-json', '{}']) {
    const corrupt = await setup({ data: { diaries: raw } });
    assert.equal((await corrupt.request('diaries')).statusCode, 503);
  }
  const missingRedis = await setup({ env: { REDIS_URL: '' } });
  assert.equal((await missingRedis.request('diaries')).statusCode, 503);
  const missingPassword = await setup({ env: { ADMIN_PASSWORD: '' } });
  assert.equal((await missingPassword.request('auth', { method: 'POST', body: { password: 'x' } })).statusCode, 503);
});

test('unresolvable CAS contention returns conflict without silently overwriting records', async () => {
  const env = await setup();
  const original = JSON.stringify([diary(1)]);
  let attempts = 0;
  const redis = { get: async () => original, eval: async () => { attempts++; return 0; } };
  await assert.rejects(env.helper.updateArray(redis, 'diaries', values => values.push(diary(2))), error => error.status === 409);
  assert.equal(attempts, 8);
});


test('a comment racing with diary deletion cannot recreate orphan comments', async () => {
  const env = await setup({ data: { diaries: JSON.stringify([diary(1)]), 'comments:1': JSON.stringify([{ id: 10 }]) } });
  const token = await env.login();
  let deletion;
  env.state.beforeEval = async keys => {
    if (keys[0] !== 'comments:1') return;
    env.state.beforeEval = null;
    deletion = await env.request('diaries', { method: 'DELETE', token, body: { id: 1 } });
  };
  const comment = await env.request('diaries', { method: 'POST', body: { action: 'addComment', diaryId: 1, content: '并发评论' } });
  assert.equal(deletion.statusCode, 200);
  assert.equal(comment.statusCode, 409);
  assert.equal(env.db.has('comments:1'), false);
  assert.deepEqual(JSON.parse(env.db.get('diaries')), []);
});


test('an ended Redis connection is replaced so later requests can recover', async () => {
  const env = await setup({ data: { diaries: JSON.stringify([diary(1)]) } });
  const first = env.helper.getRedis();
  assert.equal(env.helper.getRedis(), first);
  first.status = 'end';
  const replacement = env.helper.getRedis();
  assert.notEqual(replacement, first);
  assert.equal(env.helper.getRedis(), replacement);
  const response = await env.request('diaries');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body[0].id, 1);
});
