import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export default async function handler(req, res) {
  // 获取所有日记 - 公开
  if (req.method === 'GET') {
    const action = req.query.action;

    // 获取评论
    if (action === 'comments') {
      const diaryId = req.query.diaryId;
      if (!diaryId) {
        return res.status(400).json({ error: '缺少日记ID' });
      }

      const commentsJson = await redis.get(`comments:${diaryId}`) || '[]';
      return res.json(JSON.parse(commentsJson));
    }

    // 默认获取日记列表
    const diaries = await redis.get('diaries') || '[]';
    return res.json(JSON.parse(diaries));
  }

  // 验证 token（评论需要验证）
  const token = req.headers.authorization?.replace('Bearer ', '');

  const { action } = req.body;

  // 添加评论不需要严格验证（可以匿名评论），或者可以添加简单验证
  if (action === 'addComment') {
    const { diaryId, content, emoji, user } = req.body;

    if (!diaryId || !content) {
      return res.status(400).json({ error: '内容不能为空' });
    }

    const commentsJson = await redis.get(`comments:${diaryId}`) || '[]';
    const comments = JSON.parse(commentsJson);

    const newComment = {
      id: Date.now(),
      diaryId: diaryId,
      content: content,
      emoji: emoji || '💬',
      user: user || 'girlfriend',
      createdAt: new Date().toISOString()
    };

    comments.push(newComment);
    await redis.set(`comments:${diaryId}`, JSON.stringify(comments));

    return res.json({ success: true, comment: newComment });
  }

  // 以下操作需要验证 token
  if (!token) {
    return res.status(401).json({ error: '未授权' });
  }

  const isValid = await redis.get(`auth:${token}`);
  if (!isValid) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }

  // 保存日记
  if (req.method === 'POST') {
    const { title, content, mood, date } = req.body;

    if (!title && !content) {
      return res.status(400).json({ error: '内容不能为空' });
    }

    const diariesJson = await redis.get('diaries') || '[]';
    const diaries = JSON.parse(diariesJson);

    // 如果提供了自定义日期，使用它；否则使用当前日期
    const diaryDate = date ? new Date(date).toISOString() : new Date().toISOString();

    const newDiary = {
      id: Date.now(),
      date: diaryDate,
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
