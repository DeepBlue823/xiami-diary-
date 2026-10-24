import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { getRedis, HttpError, handleError, readBody, rateLimit, requireAuth } from '../lib/server.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const redis = getRedis();
    if (req.method !== 'POST') {
      const token = await requireAuth(redis, req);
      if (req.method === 'DELETE') await redis.del(`auth:${token}`);
      return res.json({ success: true });
    }
    const configuredPassword = process.env.ADMIN_PASSWORD;
    if (!configuredPassword) throw new HttpError(503, '登录服务尚未配置');
    const { password } = readBody(req);
    if (typeof password !== 'string' || !password || password.length > 1024) throw new HttpError(400, '请输入有效密码');
    await rateLimit(redis, req, 'login', 10, 15 * 60);
    const digest = value => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(password), digest(configuredPassword))) throw new HttpError(401, '密码错误');
    const token = randomBytes(32).toString('hex');
    await redis.set(`auth:${token}`, 'true', 'EX', 60 * 60 * 24 * 7);
    return res.json({ success: true, token });
  } catch (error) {
    return handleError(res, error);
  }
}
