import Redis from 'ioredis';
import crypto from 'crypto';

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const QUOTE_PROMPT_VERSION = 'v5-owner-boundary';

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
    ? '喵小咪第一视角：我就是喵小咪，不是日记作者哥哥。我要像读完小比格写给我的日记后亲自回应，把自己的努力、小情绪、被照顾和被喜欢的感觉说得亮晶晶。'
    : '小比格第一视角：我就是小比格，也是日记作者哥哥。我要像写完日记后亲自回应，把我对喵小咪的喜欢、守护、反省和行动说得具体又可靠。';
  const perspectiveGuard = petType === 'cat'
    ? [
        '喵小咪视角边界：日记原文里的“我”绝大多数是哥哥小比格，不是喵小咪。',
        '如果原文写“我练了手臂”“哥哥练手臂”“为见到小咪而健身”，那是小比格在练手臂；喵小咪只能说“小比格练手臂是为了抱起我”，绝不能说“我练手臂”。',
        '如果原文写哥哥开车、送人、照顾、准备礼物、道歉、想念、计划旅行，都要写成小比格对我的行动，不要写成我做了这些事。',
        '喵小咪的“我”只可以认领小咪自己的经历，例如学习、工作、照顾家人、吃饭、化妆、难过、生气、被夸、被小比格宠着。'
      ].join('\n')
    : [
        '小比格视角边界：日记作者哥哥就是我，所以原文里的“我”、哥哥、小比格、小狗通常都可以作为我的行动。',
        '如果原文写小咪学习、工作、照顾家人、吃饭、化妆、难过、生气、被夸，那是喵小咪在经历；小比格只能关心、夸奖、陪伴或回应，不能说成我经历。',
        '如果原文写小咪很辛苦，不要写“我很辛苦”，要写“我想把喵小咪的辛苦接住”。'
      ].join('\n');
  const prompt = [
    `点击对象：${petName}`,
    `另一只宠物：${partnerName}`,
    `本次是第 ${variantIndex + 1} 个版本，请和另外 9 个版本明显不同。`,
    '',
    '请阅读下面今天和前一天的小咪日记，理解其中的事情、情绪和关系。',
    '最重要事实：这本日记是哥哥写的，哥哥就是小比格。',
    '日记称呼映射必须牢记：哥哥、我、自己、比格、小狗都默认指小比格；小咪宝宝、咪宝宝、咪宝、小猫、猫猫、咪咪、小咪都指喵小咪。',
    '动作归属必须先判断再改写：哥哥写下、道歉、准备礼物、想念、照顾、反省、健身、练手臂、计划见面，是小比格在做；小咪学习、工作、吃饭、化妆、生气、难过、被夸、被照顾，是喵小咪在经历。',
    perspectiveGuard,
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
    '8. 如果点击喵小咪，不要把哥哥或小比格做的事说成我做的事；如果点击小比格，不要把喵小咪的经历说成我经历。',
    '9. 不要写成旁白，不要同时替两只宠物说话。',
    '10. 输出前自检：这句话里的我必须等于点击对象，所有动作归属必须和日记事实一致；如果不一致，重写。',
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
          content: '你是小咪日记的宠物语录生成器。日记作者哥哥就是小比格；只输出一句点击对象第一视角的中文短句，句子里的我必须等于点击对象。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      stream: false,
      temperature: 0.82,
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
