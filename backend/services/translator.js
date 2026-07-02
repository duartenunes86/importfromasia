/**
 * Translation Service — Chinese (Simplified) → English
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

async function translateMyMemory(text) {
  const params = {
    q: text,
    langpair: 'zh-CN|en',
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

module.exports = { translateToEnglish, translateBatch };
