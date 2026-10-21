/**
 * Search routes
 *
 * GET /api/search?q=keyword&page=1&pageSize=20&sort=default&priceMin=&priceMax=
 *     (q=img:<imageId> searches by an uploaded photo instead of a keyword)
 * POST /api/image-upload   (raw image body) → { imageId }
 * GET /api/product/:id
 * GET /api/rates
 */

const express    = require('express');
const router     = express.Router();

const { searchProducts, searchByImage, uploadImage, getProductDetail } = require('../services/search1688');
const { translateBatch, translateToChinese } = require('../services/translator');
const { getCurrencyForIp, convertFromCny, getExchangeRates } = require('../services/currency');

// 15% markup applied by the currency service — used to reverse display-currency
// price filters back into CNY so we can filter results.
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

const PAGE_SIZE = 50;  // items per page (API hard limit — 100 returns nothing)

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

    // One API batch of 50 per page; for price-asc the Elim API sorts server-side
    const imageId = query.match(/^img:(\d+)$/)?.[1];
    const filters = {
      sort,
      priceMin: Number.isFinite(minCny) ? minCny : undefined,
      priceMax: Number.isFinite(maxCny) ? maxCny : undefined,
    };
    const result  = imageId
      ? await searchByImage(imageId, page, PAGE_SIZE, filters)
      : await searchProducts(await translateToChinese(query), page, PAGE_SIZE, filters);
    const total  = result.total;
    const slice  = result.products.filter(p => p.priceCny > 0 && inRange(p));

    // Translate + convert the visible slice
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
// POST /api/image-upload — body is the raw photo (Content-Type: image/*)
// ---------------------------------------------------------------------------
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

router.post('/image-upload', express.raw({ type: 'image/*', limit: '10mb' }), async (req, res) => {
  const type = req.headers['content-type'];
  if (!IMAGE_TYPES.has(type) || !req.body?.length) {
    return res.status(400).json({ error: 'Please upload a JPEG, PNG or WebP photo.' });
  }

  try {
    res.json({ imageId: await uploadImage(req.body, type) });
  } catch (err) {
    console.error('[/api/image-upload]', err.message);
    res.status(502).json({
      error:  'Could not upload the photo. Please try again.',
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
