import Redis from 'ioredis';
import crypto from 'crypto';

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const QUOTE_PROMPT_VERSION = 'v2-perspective';

function normalizePetType(petType) {
  return petType === 'dog' ? 'dog' : 'cat';
}

function normalizeVariantIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index % 10 : 0;
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

function cacheKeyFor(petType, variantIndex, diaries) {
  const input = JSON.stringify({
    version: QUOTE_PROMPT_VERSION,
    petType,
    variantIndex,
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

  return `pet-quote:${QUOTE_PROMPT_VERSION}:${petType}:${variantIndex}:${digest}`;
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
  const variantIndex = normalizeVariantIndex(req.body?.variantIndex);
  const diaries = Array.isArray(req.body?.diaries)
    ? req.body.diaries.slice(0, 2).map(normalizeDiary)
    : [];

  if (!diaries.length) {
    return res.status(400).json({ error: '缺少日记内容' });
  }

  const cacheKey = cacheKeyFor(petType, variantIndex, diaries);

  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json({ quote: cached, cached: true });
    }
  }

  const petName = petType === 'cat' ? '喵小咪' : '小比格';
  const partnerName = petType === 'cat' ? '小比格' : '喵小咪';
  const petVoice = petType === 'cat'
    ? '喵小咪第一视角：我就是喵小咪，灵动、会撒娇，会把自己的努力、小情绪和被小比格宠爱的感觉说得亮晶晶。'
    : '小比格第一视角：我就是小比格，活泼、真诚，会把哥哥的喜欢、守护和行动说得具体又可靠。';
  const prompt = [
    `点击对象：${petName}`,
    `另一只宠物：${partnerName}`,
    `本次是第 ${variantIndex + 1} 个版本，请和另外 9 个版本明显不同。`,
    '',
    '请阅读下面今天和前一天的小咪日记，理解其中的事情、情绪和关系。',
    '生成一句像这只宠物说出来的中文语录。',
    `角色语气：${petVoice}`,
    '要求：',
    '1. 不要摘抄原文，要先理解再改写成新的句子，不要加引号。',
    '2. 不要输出 emoji、括号、Markdown、解释或多句。',
    '3. 语气更活泼、更亲密、更可爱，可以俏皮，但不要油腻。',
    '4. 必须结合日记里的一个具体内容，例如学习、工作、健身、美食、见面、道歉、游戏、地点或当天事件。',
    '5. 30 到 50 个中文字。',
    '6. 称呼只能使用喵小咪和小比格。',
    '7. 必须使用点击对象的第一视角，可以说我；喵小咪的我不是小比格，小比格的我不是喵小咪。',
    '8. 不要写成旁白，不要同时替两只宠物说话。',
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
          content: '你是小咪日记的宠物语录生成器，只输出一句点击对象第一视角的中文短句。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      stream: false,
      temperature: 0.95,
      max_tokens: 120
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
