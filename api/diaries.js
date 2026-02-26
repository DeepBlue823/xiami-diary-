import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export default async function handler(req, res) {
  // 获取所有日记 - 公开
  if (req.method === 'GET') {
    const diaries = await redis.get('diaries') || '[]';
    return res.json(JSON.parse(diaries));
  }

  // 验证 token
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: '未授权' });
  }

  const isValid = await redis.get(`auth:${token}`);
  if (!isValid) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }

  // 保存日记
  if (req.method === 'POST') {
    const { title, content, mood } = req.body;

    if (!title && !content) {
      return res.status(400).json({ error: '内容不能为空' });
    }

    const diariesJson = await redis.get('diaries') || '[]';
    const diaries = JSON.parse(diariesJson);

    const newDiary = {
      id: Date.now(),
      date: new Date().toISOString(),
      title: title || '无标题',
      content: content,
      mood: mood || null
    };

    diaries.unshift(newDiary);
    await redis.set('diaries', JSON.stringify(diaries));

    return res.json({ success: true, diary: newDiary });
  }

  // 删除日记
  if (req.method === 'DELETE') {
    const { id } = req.body;
    const diariesJson = await redis.get('diaries') || '[]';
    let diaries = JSON.parse(diariesJson);
    diaries = diaries.filter(d => d.id !== id);
    await redis.set('diaries', JSON.stringify(diaries));

    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
