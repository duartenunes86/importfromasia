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

// Catholic items: English phrases → the Chinese terms 1688 sellers actually use.
// Each was picked by comparing how many of the top 50 Elim results were the
// right product (e.g. "saint michael medal" → 圣迈克尔奖章 finds challenge coins,
// 圣迈克尔吊坠 finds the pendants; "rosary" → 念珠 finds Buddhist bracelets).
// Applied in order, so longer phrases come first. Queries are lowercased and
// "st"/"st." normalised to "saint" before matching.
const CATHOLIC_TERMS = [
  [/\b(divine mercy )?chaplets?\b/,                               '十字架念珠手链'],
  [/\brosary bracelets?\b/,                                       '十字架念珠手链'],
  [/\brosary rings?\b/,                                           '十字架戒指'],
  [/\brosary (box|boxes|case|cases)\b/,                           '十字架念珠盒'],
  [/\brosary (pouch|pouches|bag|bags)\b/,                         '念珠袋'],
  [/\b(catholic )?(rosary|rosaries|rosario|rosarios)( beads?)?\b/,                 '十字架念珠项链'],
  [/\bmiraculous medals?\b/,                                      '圣母像项链'],
  [/\b(our lady of |(la )?virgen de )?guadalupe\b/,               '瓜达卢佩'],
  [/\b(our lady of )?fatima\b/,                                   '法蒂玛'],
  [/\b(the )?(blessed )?(virgin mary|blessed mother|blessed virgin|mother mary|our lady( of [a-z]+)?|madonna|virgen( maria)?)\b/, '圣母像'],
  [/\b(saint michael( the archangel)?|archangel michael|san miguel)\b/, '圣迈克尔'],
  [/\b(saint benedict|san benito)\b/,                             '圣本笃'],
  [/\bsaint christopher\b/,                                       '圣克里斯托弗'],
  [/\b(saint jude|san judas( tadeo)?)\b/,                         '圣裘德'],
  // Not sold under their own names on 1688 — show saint medals generally
  [/\b(saint (therese|theresa|rita|sebastian|lucy|florian)|padre pio|saint pio)( medals?)?\b/, '圣人吊坠'],
  [/\b(patron )?saint medals?\b|\bpatron saints?\b/,             '圣人吊坠'],
  [/\bsaint francis( of assisi)?\b/,                              '圣方济'],
  [/\bsaint joseph\b/,                                            '圣若瑟'],
  [/\bsaint anthony( of padua)?\b/,                               '圣安东尼'],
  [/\b(brown )?(scapulars?|escapularios?)\b/,                                     '圣衣吊坠'],   // → "Scapular 吊坠" after translation
  [/\bwall (crucifix|crucifixes|cross|crosses)\b/,                '挂墙十字架'],
  [/\b(crucifix(es)?|crucifijos?)\b/,                             '十字架'],
  [/\bnativity( sets?| scenes?)?\b|\bmangers?\b/,                 '圣诞马槽'],
  [/\b(jesus|christ) (statue|figurine)s?\b/,                      '圣心摆件'],
  [/\bsacred heart( of (jesus|christ))?\b/,                       '圣心'],
  [/\b(priest|clergy|pastor) stoles?\b/,                          '牧师绶带披肩'],
  [/\b(chasubles?|vestments?)\b/,                                 '神职人员服装'],
  [/\b(chapel|church) veils?\b|\bmantillas?\b/,                   '教堂头纱'],
  [/\bholy water bottles?\b/,                                     '圣水瓶'],
  [/\bfirst (holy )?communion\b/,                                 '圣餐'],
  [/\b(baptism|christening)\b/,                                   '洗礼'],
  [/\bconfirmation gifts?\b/,                                     '坚信礼'],
  [/\b(censers?|thuribles?)\b/,                                   '教堂香炉'],
  [/\bguardian angel (statue|figurine)s?\b/,                      '守护天使摆件'],
  [/\bguardian angels?\b/,                                       '守护天使吊坠'],
  [/\b(religious |holy )?icons?\b/,                                '圣像'],
  [/\bsaint (statue|figurine)s?\b/,                               '圣像摆件'],
  [/\b(catholic|religious)\b/,                                    '十字架'],
];

// "medal" means a pendant (吊坠) for religious items, but an award (奖章) otherwise
const RELIGIOUS_CONTEXT = /\b(saint|holy|catholic|religious|christian|patron|miraculous|baptism|communion)\b/;

// Words 1688 blocks (a query containing them returns 0 results or junk), found
// by testing: 天主教/宗教/耶稣 → swap for 十字架 (cross); 圣母 only works as 圣母像.
function unblockQuery(zh) {
  return zh
    .replace(/^[a-z]+\.\s*/i, '')                        // MyMemory part-of-speech prefix, e.g. "adj.宗教"
    .replace(/圣母玛利亚|处女玛丽|纯真玛丽|玛利亚|玛丽亚|圣母(?!像)/g, '圣母像')
    .replace(/天主教|宗教|耶稣/g, '十字架')
    .replace(/([\u4e00-\u9fff]{2,})\1+/g, '$1');         // collapse repeats, e.g. 项链项链
}

/**
 * Replace Catholic glossary phrases in a query with their Chinese terms,
 * leaving the rest in English. Returns null if nothing matched.
 */
function applyCatholicTerms(text) {
  let q = text.toLowerCase().replace(/\bst\.?\s/g, 'saint ').replace(/\s+/g, ' ').trim();
  let matched = false;
  for (const [re, zh] of CATHOLIC_TERMS) {
    q = q.replace(new RegExp(re, 'g'), () => { matched = true; return zh; });
  }
  if (matched || RELIGIOUS_CONTEXT.test(q)) {
    q = q.replace(/\b(medals?|medallas?)\b/g, () => { matched = true; return '吊坠'; });
    // "cross" is a crucifix here, not 交叉 (intersect) as the translator has it
    q = q.replace(/\bcross(es)?\b(?![- ]?(body|border|stitch))/g, () => { matched = true; return '十字架'; });
  }
  if (!matched) return null;
  return q.replace(/\b(of|the|a|an|de|del|la|el|los|las)\b/g, ' ')   // filler left between terms
          .replace(/\s*([\u4e00-\u9fff]+)\s*/g, '$1').replace(/\s+/g, ' ').trim();
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

  const cacheKey = `zh:${text.toLowerCase().trim()}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    // MyMemory keeps the Chinese glossary terms and translates the English
    // around them in context ("silver 圣迈克尔吊坠 for men" → 银色圣迈克尔吊坠男士)
    const query = applyCatholicTerms(text) ?? text;
    let result = /[a-z]/i.test(query) ? await translateMyMemory(query, 'en|zh-CN') : query;
    // Quota warnings etc. come back as English text — keep the original query
    if (isAlreadyEnglish(result)) result = query;
    result = unblockQuery(result).replace(/圣衣吊坠/g, 'Scapular 吊坠');
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
