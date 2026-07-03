/**
 * Search routes
 *
 * GET /api/search?q=keyword&page=1&pageSize=20&sort=default&priceMin=&priceMax=
 * GET /api/product/:id
 * GET /api/rates
 */

const express    = require('express');
const NodeCache  = require('node-cache');
const router     = express.Router();

const { searchProducts, getProductDetail } = require('../services/search1688');
const { translateBatch }                   = require('../services/translator');
const { getCurrencyForIp, convertFromCny, getExchangeRates } = require('../services/currency');

// Cache the lowest-price-sorted pool for 5 minutes (keyed by query)
const poolCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// 15% markup applied by the currency service — used to reverse display-currency
// price filters back into CNY so we can filter the pool.
const CURRENCY_SPREAD = 0.15;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress || ''
  ).replace('::ffff:', '');
}

const VALID_CURRENCIES = new Set(['GBP', 'EUR', 'USD']);
const SYM = { GBP: '£', EUR: '€', USD: '$' };

function resolveCurrency(req) {
  const c = req.query.currency;
  if (VALID_CURRENCIES.has(c)) return Promise.resolve({ currency: c, symbol: SYM[c] });
  return getCurrencyForIp(clientIp(req));
}

// ---------------------------------------------------------------------------
// GET /api/search
// ---------------------------------------------------------------------------

const FETCH_PAGES  = 15;  // batches pulled for the price-sorted pool
const FETCH_SIZE   = 50;  // items per API call (API hard limit — 100 returns nothing)
const PAGE_SIZE    = 50;  // items shown per page to the user (one API batch)

/**
 * Build a pool of products for a query: pull FETCH_PAGES pages from the Elim API
 * in parallel, drop items with no usable price, dedupe by id, and sort ascending
 * by CNY price (lowest first). Cached for the poolCache TTL.
 */
async function buildPool(query) {
  const pages = await Promise.all(
    Array.from({ length: FETCH_PAGES }, (_, i) =>
      searchProducts(query, i + 1, FETCH_SIZE).catch(() => ({ products: [], total: 0 }))
    )
  );

  const seen   = new Set();
  const merged = [];
  for (const pg of pages) {
    for (const item of pg.products) {
      if (item.priceCny > 0 && !seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
  }

  merged.sort((a, b) => a.priceCny - b.priceCny);
  return merged;
}

router.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const sort  = req.query.sort === 'price-asc' ? 'price-asc' : 'default';

  if (!query) return res.status(400).json({ error: 'Query parameter "q" is required.' });

  try {
    const { currency, symbol } = await resolveCurrency(req);

    // Optional price filter — inputs arrive in the display currency, so reverse
    // them back into CNY (undo the exchange rate + 15% markup) before filtering.
    const priceMin = parseFloat(req.query.priceMin) || undefined;
    const priceMax = parseFloat(req.query.priceMax) || undefined;
    let minCny = -Infinity, maxCny = Infinity;
    if (priceMin != null || priceMax != null) {
      const rates = await getExchangeRates();
      const eff   = rates[currency] * (1 + CURRENCY_SPREAD);  // display = cny × eff
      if (priceMin != null) minCny = priceMin / eff;
      if (priceMax != null) maxCny = priceMax / eff;
    }
    const inRange = p => p.priceCny >= minCny && p.priceCny <= maxCny;

    let slice, total;

    if (sort === 'price-asc') {
      // ── Lowest price: pool 15 batches of 50, sort ascending, paginate ──
      const cacheKey = `pool:${query.toLowerCase()}`;
      let pool = poolCache.get(cacheKey);
      if (!pool) {
        pool = await buildPool(query);
        poolCache.set(cacheKey, pool);
      }
      const filtered = pool.filter(inRange);
      total = filtered.length;
      const start = (page - 1) * PAGE_SIZE;
      slice = filtered.slice(start, start + PAGE_SIZE);
    } else {
      // ── Relevance (default): one API batch of 50 in the API's own order ──
      const result = await searchProducts(query, page, PAGE_SIZE);
      total = result.total;
      slice = result.products.filter(p => p.priceCny > 0 && inRange(p));
    }

    // Translate + convert only the visible slice (keeps the pool cheap)
    const titles = await translateBatch(slice.map(p => p.title));
    const enriched = await Promise.all(
      slice.map(async (p, i) => ({
        id:       p.id,
        title:    titles[i] || p.title,
        imageUrl: p.imageUrl,
        priceCny: p.priceCny,
        price:    await convertFromCny(p.priceCny, currency),
        minOrder: p.minOrder,
        unit:     p.unit,
        supplier: p.supplier,
        sales:    p.sales,
        currency,
        symbol,
      }))
    );

    res.json({ query, page, pageSize: PAGE_SIZE, total, currency, symbol, products: enriched });

  } catch (err) {
    console.error('[/api/search]', err.message);
    res.status(502).json({
      error:  'Failed to fetch results. Please try again.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// ---------------------------------------------------------------------------
// Strip 1688 references from description HTML
// ---------------------------------------------------------------------------
function sanitiseDescription(html) {
  if (!html) return '';
  return html
    .replace(/1688\.com/gi, '')
    .replace(/1688/gi, '')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/font-family:[^;"]*/gi, '')
    .replace(/zoom\s*:\s*[\d.]+/gi, '')
    .replace(/ali-webfont/gi, '');
}

// ---------------------------------------------------------------------------
// GET /api/product/:id
// ---------------------------------------------------------------------------
router.get('/product/:id', async (req, res) => {
  if (!req.params.id) return res.status(400).json({ error: 'Product ID is required.' });

  try {
    const [{ currency, symbol }, product] = await Promise.all([
      resolveCurrency(req),
      getProductDetail(req.params.id),
    ]);

    res.json({
      ...product,
      price:       product.priceCny > 0 ? await convertFromCny(product.priceCny, currency) : null,
      description: sanitiseDescription(product.description),
      currency,
      symbol,
    });

  } catch (err) {
    console.error('[/api/product]', err.message);
    res.status(502).json({
      error:  'Failed to fetch product details.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/rates
// ---------------------------------------------------------------------------
router.get('/rates', async (req, res) => {
  try {
    res.json({ base: 'CNY', rates: await getExchangeRates() });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch exchange rates.' });
  }
});

module.exports = router;
