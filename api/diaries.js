import {
  getRedis, HttpError, handleError, readBody, requireAuth, rateLimit,
  parseArray, updateArray, newId, readId, readText, readDate
} from '../lib/server.js';

const moods = new Set(['happy', 'love', 'peaceful', 'sad', 'angry', 'tired']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const redis = getRedis();
    if (req.method === 'GET') {
      const { action, diaryId } = req.query || {};
      if (action === 'comments') return res.json(parseArray(await redis.get(`comments:${readId(diaryId)}`)));
      if (action === 'meetings') return res.json(parseArray(await redis.get('meetings')));
      if (action) throw new HttpError(400, '未知操作');
      return res.json(parseArray(await redis.get('diaries')));
    }
    const body = readBody(req);
    const { action } = body;
    const allowed = req.method === 'POST' ? [undefined, 'addMeeting', 'addComment'] : [undefined, 'deleteMeeting', 'deleteComment'];
    if (!allowed.includes(action)) throw new HttpError(400, '未知操作');

    if (action === 'addComment') {
      const diaryId = readId(body.diaryId);
      const content = readText(body.content, 2000, '评论');
      const emoji = readText(body.emoji, 32, '表情') || '💬';
      const user = body.user || 'girlfriend';
      if (!content) throw new HttpError(400, '内容不能为空');
      if (!['girlfriend', 'boyfriend', 'me'].includes(user)) throw new HttpError(400, '评论身份无效');
      if (user !== 'girlfriend') await requireAuth(redis, req);
      await rateLimit(redis, req, 'comment', 20, 60);
      const diariesRaw = await redis.get('diaries');
      const diaries = parseArray(diariesRaw);
      if (!diaries.some(diary => diary.id === diaryId)) throw new HttpError(404, '日记不存在');
      const comment = await updateArray(redis, `comments:${diaryId}`, comments => {
        const value = { id: newId(comments), diaryId, content, emoji,
          user: user === 'me' ? 'boyfriend' : user, createdAt: new Date().toISOString() };
        comments.push(value);
        return value;
      }, undefined, { key: 'diaries', raw: diariesRaw });
      return res.json({ success: true, comment });
    }
    await requireAuth(redis, req);

    if (action === 'addMeeting') {
      const startDate = readDate(body.startDate);
      const endDate = readDate(body.endDate);
      if (endDate < startDate) throw new HttpError(400, '结束日期不能早于开始日期');
      const meeting = await updateArray(redis, 'meetings', meetings => {
        const value = { id: newId(meetings), startDate, endDate };
        meetings.push(value);
        return value;
      });
      return res.json({ success: true, meeting });
    }
    if (action === 'deleteMeeting' || action === 'deleteComment' || req.method === 'DELETE') {
      const id = readId(action === 'deleteComment' ? body.commentId : body.id);
      const key = action === 'deleteMeeting' ? 'meetings'
        : action === 'deleteComment' ? `comments:${readId(body.diaryId)}` : 'diaries';
      await updateArray(redis, key, values => {
        const index = values.findIndex(value => value.id === id);
        if (index !== -1) values.splice(index, 1);
      }, key === 'diaries' ? `comments:${id}` : undefined);
      return res.json({ success: true });
    }
    const id = body.id === undefined || body.id === null ? null : readId(body.id);
    const title = readText(body.title, 200, '标题');
    const content = readText(body.content, 100000, '正文');
    if (!title && !content) throw new HttpError(400, '内容不能为空');
    if (body.mood != null && body.mood !== '' && !moods.has(body.mood)) throw new HttpError(400, '心情无效');
    const girlfriendLocation = readText(body.girlfriendLocation, 200, '地点') || null;
    const myLocation = readText(body.myLocation, 200, '地点') || null;
    const date = body.date == null || body.date === '' ? null : `${readDate(body.date)}T00:00:00.000Z`;
    const diary = await updateArray(redis, 'diaries', diaries => {
      const previous = id === null ? null : diaries.find(value => value.id === id);
      if (id !== null && !previous) throw new HttpError(404, '日记不存在，请刷新后重试');
      const value = { ...previous, id: previous?.id ?? newId(diaries),
        date: date || previous?.date || new Date().toISOString(), title: title || '无标题',
        content, mood: body.mood || null, girlfriendLocation, myLocation };
      if (previous) diaries[diaries.indexOf(previous)] = value;
      else diaries.unshift(value);
      return value;
    });
    return res.json({ success: true, diary });
  } catch (error) {
    return handleError(res, error);
  }
}
