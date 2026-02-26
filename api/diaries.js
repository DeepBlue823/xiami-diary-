const { kv } = require('@vercel/kv');

export default async function handler(req, res) {
  // 获取所有日记 - 公开
  if (req.method === 'GET') {
    const diaries = await kv.get('diaries') || [];
    return res.json(diaries);
  }

  // 验证 token
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: '未授权' });
  }

  const isValid = await kv.get(`auth:${token}`);
  if (!isValid) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }

  // 保存日记
  if (req.method === 'POST') {
    const { title, content, mood } = req.body;

    if (!title && !content) {
      return res.status(400).json({ error: '内容不能为空' });
    }

    const diaries = await kv.get('diaries') || [];

    const newDiary = {
      id: Date.now(),
      date: new Date().toISOString(),
      title: title || '无标题',
      content: content,
      mood: mood || null
    };

    diaries.unshift(newDiary);
    await kv.set('diaries', diaries);

    return res.json({ success: true, diary: newDiary });
  }

  // 删除日记
  if (req.method === 'DELETE') {
    const { id } = req.body;
    let diaries = await kv.get('diaries') || [];
    diaries = diaries.filter(d => d.id !== id);
    await kv.set('diaries', diaries);

    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
