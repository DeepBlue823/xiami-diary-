const { kv } = require('@vercel/kv');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'xiami520';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body;

  if (password === ADMIN_PASSWORD) {
    // 设置一个 token，有效期 7 天
    const token = Buffer.from(`${Date.now()}:${ADMIN_PASSWORD}`).toString('base64');
    await kv.set(`auth:${token}`, 'true', { ex: 60 * 60 * 24 * 7 });
    return res.json({ success: true, token });
  }

  return res.status(401).json({ error: '密码错误' });
}
