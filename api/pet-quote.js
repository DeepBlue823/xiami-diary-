import Redis from 'ioredis';
import crypto from 'crypto';

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

function normalizePetType(petType) {
  return petType === 'dog' ? 'dog' : 'cat';
}

function cleanText(text, maxLength = 1200) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeDiary(diary) {
  return {
    id: diary?.id || '',
    date: diary?.date || '',
    title: cleanText(diary?.title, 80),
    content: cleanText(diary?.content, 1400),
    mood: cleanText(diary?.mood, 30),
    girlfriendLocation: cleanText(diary?.girlfriendLocation, 80),
    myLocation: cleanText(diary?.myLocation, 80)
  };
}

function cacheKeyFor(petType, diaries) {
  const input = JSON.stringify({
    petType,
    diaries: diaries.map((diary) => ({
      id: diary.id,
      date: diary.date,
      title: diary.title,
      content: diary.content,
      mood: diary.mood,
      girlfriendLocation: diary.girlfriendLocation,
      myLocation: diary.myLocation
    }))
  });
  const digest = crypto.createHash('sha256').update(input).digest('hex').slice(0, 20);

  return `pet-quote:${petType}:${digest}`;
}

function cleanQuote(quote) {
  return String(quote || '')
    .replace(/["“”‘’]/g, '')
    .replace(/[^\u3400-\u9fffA-Za-z0-9，。！？、；：\s]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 80);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: '缺少 DEEPSEEK_API_KEY 环境变量' });
  }

  const petType = normalizePetType(req.body?.petType);
  const diaries = Array.isArray(req.body?.diaries)
    ? req.body.diaries.slice(0, 2).map(normalizeDiary)
    : [];

  if (!diaries.length) {
    return res.status(400).json({ error: '缺少日记内容' });
  }

  const cacheKey = cacheKeyFor(petType, diaries);

  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json({ quote: cached, cached: true });
    }
  }

  const petName = petType === 'cat' ? '喵小咪' : '小比格';
  const partnerName = petType === 'cat' ? '小比格' : '喵小咪';
  const prompt = [
    `点击对象：${petName}`,
    `另一只宠物：${partnerName}`,
    '',
    '请阅读下面今天和前一天的小咪日记，理解其中的事情、情绪和关系。',
    '生成一句像这只宠物说出来的中文语录。',
    '要求：',
    '1. 不要摘抄原文，不要加引号。',
    '2. 不要输出 emoji、括号、Markdown、解释或多句。',
    '3. 语气温柔、亲密、可爱，但不要油腻。',
    '4. 35 个中文字以内。',
    '5. 称呼只能使用喵小咪和小比格。',
    '',
    `日记 JSON：${JSON.stringify(diaries)}`
  ].join('\n');

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content: '你是小咪日记的宠物语录生成器，只输出一句干净自然的中文短句。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      stream: false,
      temperature: 0.8,
      max_tokens: 80
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    return res.status(502).json({
      error: 'DeepSeek 请求失败',
      detail: detail.slice(0, 240)
    });
  }

  const data = await response.json();
  const quote = cleanQuote(data.choices?.[0]?.message?.content);

  if (!quote) {
    return res.status(502).json({ error: 'DeepSeek 未返回有效语录' });
  }

  if (redis) {
    await redis.set(cacheKey, quote, 'EX', 60 * 60 * 24);
  }

  return res.json({ quote, cached: false });
}
