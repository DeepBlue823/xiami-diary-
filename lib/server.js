import Redis from 'ioredis';
import { createHash, randomInt } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let client;
export function getRedis() {
  if (!process.env.REDIS_URL) throw new HttpError(503, '服务暂时不可用，请稍后重试');
  if (!client || client.status === 'end') {
    client = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    });
    client.on('error', () => {});
  }
  return client;
}

export function handleError(res, error) {
  return res.status(error instanceof HttpError ? error.status : 503)
    .json({ error: error instanceof HttpError ? error.message : '服务暂时不可用，请稍后重试' });
}

export function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { throw new HttpError(400, '请求格式不正确'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求格式不正确');
  return body;
}

export async function requireAuth(redis, req) {
  const authorization = req.headers?.authorization;
  const token = typeof authorization === 'string' && /^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1];
  // Legacy tokens exposed the password and must no longer be accepted.
  if (!token || await redis.get(`auth:${token}`) !== 'true') throw new HttpError(401, '登录已过期，请重新登录');
  return token;
}

const LIMIT_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return count
`;

export async function rateLimit(redis, req, scope, limit, seconds, { global = false } = {}) {
  const address = req.headers?.['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const identity = global ? 'global' : createHash('sha256').update(String(address)).digest('hex').slice(0, 32);
  const count = await redis.eval(LIMIT_SCRIPT, 1, `rate:${scope}:${identity}`, seconds);
  if (Number(count) > limit) throw new HttpError(429, '操作太频繁，请稍后再试');
}

export function parseArray(raw) {
  const value = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('Invalid stored data');
  return value;
}

// Compare-and-set preserves concurrent writes and the existing JSON format.
const UPDATE_SCRIPT = `
  if ARGV[4] ~= '' and redis.call('GET', KEYS[#KEYS]) ~= ARGV[4] then return -1 end
  local current = redis.call('GET', KEYS[1])
  if (not current and ARGV[1] == 'missing') or (current and ARGV[1] == 'present' and current == ARGV[2]) then
    redis.call('SET', KEYS[1], ARGV[3])
    if ARGV[5] == 'delete' then redis.call('DEL', KEYS[2]) end
    return 1
  end
  return 0
`;

export async function updateArray(redis, key, mutate, deleteKey, guard) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = await redis.get(key);
    const values = parseArray(raw);
    const result = mutate(values);
    const keys = deleteKey ? [key, deleteKey] : [key];
    if (guard) keys.push(guard.key);
    const updated = await redis.eval(UPDATE_SCRIPT, keys.length, ...keys,
      raw === null ? 'missing' : 'present', raw ?? '', JSON.stringify(values),
      guard?.raw ?? '', deleteKey ? 'delete' : 'keep');
    if (Number(updated) === -1) throw new HttpError(409, '日记已发生变化，请刷新后重试');
    if (Number(updated) === 1) return result;
  }
  throw new HttpError(409, '数据正在被更新，请重试');
}

export function newId(values) {
  let id;
  do { id = Date.now() * 1000 + randomInt(1000); } while (values.some(value => value.id === id));
  return id;
}

export function readId(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) throw new HttpError(400, '无效的记录 ID');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, '无效的记录 ID');
  return id;
}

export function readText(value, max, label, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${label}格式或长度不正确`);
  return value.trim();
}

export function readDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, '日期格式不正确');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new HttpError(400, '日期无效');
  return value;
}
