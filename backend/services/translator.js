/**
 * Translation Service — Chinese (Simplified) ⇄ English
 *
 * Uses MyMemory's free public API (no key required for basic use).
 * Falls back gracefully if translation fails, returning the original text.
 *
 * Rate limits (MyMemory free tier): ~1000 words/day per IP.
 * To remove limits, set MYMEMORY_EMAIL in env (bumps quota significantly).
 * Alternatively set DEEPL_API_KEY or GOOGLE_TRANSLATE_API_KEY to switch provider.
 */

const axios  = require('axios');
const NodeCache = require('node-cache');

// Cache translations for 24 hours to save quota
const cache = new NodeCache({ stdTTL: 86400, checkperiod: 600 });

/**
 * Translate a single string from Chinese to English.
 * Returns the original string if translation is unavailable.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
async function translateToEnglish(text) {
  if (!text || !text.trim()) return text;

  // Skip if already mostly ASCII (already English / numbers)
  if (isAlreadyEnglish(text)) return text;

  const cacheKey = `tr:${text}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const result = await translateMyMemory(text);
    cache.set(cacheKey, result);
    return result;
  } catch {
    // Fail silently — show original text rather than crashing
    return text;
  }
}

// Queries where a literal translation finds the wrong products on 1688
// (e.g. "rosary beads" → 念珠 returns Buddhist bracelets) or nothing at all —
// 1688 blocks some religious terms (天主教, 圣母玛利亚, 宗教饰品 return 0 results).
// Keys are lowercase.
const QUERY_OVERRIDES = {
  'rosary':          '十字架念珠项链',
  'rosaries':        '十字架念珠项链',
  'rosary beads':    '十字架念珠项链',
  'catholic rosary': '十字架念珠项链',
  'catholic':        '十字架',
  'religious':       '十字架',
  'virgin mary':     '圣母像',
  'our lady':        '圣母像',
  'madonna':         '圣母像',
};

// Words 1688 blocks inside a query (any query containing them returns 0 results),
// swapped for 十字架 (cross), which returns religious items. Longest first.
const BLOCKED_TERMS = /圣母玛利亚|处女玛丽|纯真玛丽|玛利亚|圣母|天主教|宗教/g;

function unblockQuery(zh) {
  return zh
    .replace(/^[a-z]+\.\s*/i, '')            // MyMemory part-of-speech prefix, e.g. "adj.宗教"
    .replace(BLOCKED_TERMS, '十字架')
    .replace(/(十字架)+/g, '十字架');         // collapse repeats from adjacent swaps
}

/**
 * Translate an English search query to Chinese (Simplified), so Elim searches
 * the right term — its own translation of e.g. "micropipette" matches incense.
 * Returns the original query if it already contains Chinese or translation fails.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
async function translateToChinese(text) {
  if (!text || !text.trim() || !isAlreadyEnglish(text)) return text;

  const override = QUERY_OVERRIDES[text.trim().toLowerCase().replace(/\s+/g, ' ')];
  if (override) return override;

  const cacheKey = `zh:${text.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    let result = unblockQuery(await translateMyMemory(text, 'en|zh-CN'));
    // Quota warnings etc. come back as English text — keep the original query
    if (isAlreadyEnglish(result)) result = text;
    cache.set(cacheKey, result);
    return result;
  } catch {
    return text;
  }
}

/**
 * Translate an array of strings in a single batch.
 * Runs translations concurrently with a small concurrency cap.
 *
 * @param {string[]} texts
 * @returns {Promise<string[]>}
 */
async function translateBatch(texts) {
  const CONCURRENCY = 5;
  const results = [];

  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const chunk = texts.slice(i, i + CONCURRENCY);
    const translated = await Promise.all(chunk.map(t => translateToEnglish(t)));
    results.push(...translated);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function translateMyMemory(text, langpair = 'zh-CN|en') {
  const params = {
    q: text,
    langpair,
  };

  if (process.env.MYMEMORY_EMAIL) {
    params.de = process.env.MYMEMORY_EMAIL;
  }

  const { data } = await axios.get('https://api.mymemory.translated.net/get', {
    params,
    timeout: 8000,
  });

  const translated = data?.responseData?.translatedText;
  if (!translated || translated === 'INVALID LANGUAGE PAIR SPECIFIED') {
    return text;
  }

  // MyMemory sometimes returns HTML-encoded quotes
  return translated.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAlreadyEnglish(text) {
  // Count non-ASCII characters; if fewer than 20% are CJK, skip translation
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return cjkCount === 0;
}

module.exports = { translateToEnglish, translateToChinese, translateBatch };
