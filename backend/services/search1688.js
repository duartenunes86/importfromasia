/**
 * Product Search Service via Elim.asia API
 *
 * Base URL : https://openapi.elim.asia
 * Auth     : POST /v1/auth/login with email+password → JWT
 *            JWT cached in memory; refreshed on expiry.
 */

const axios = require('axios');

const BASE_URL = process.env.ELIMAPI_BASE_URL || 'https://openapi.elim.asia';
const EMAIL    = process.env.ELIMAPI_EMAIL;
const PASSWORD = process.env.ELIMAPI_PASSWORD;

// Sort values supported by the Elim API
const SORT_MAP = {
  default:      undefined,
  'price-asc':  'PRICE_ASC',
  'price-desc': 'PRICE_DESC',
  sales:        'SALE_QTY_DESC',
};

// In-memory token cache
let _token     = null;
let _expiresAt = 0;   // ms epoch

async function getToken() {
  if (_token && Date.now() < _expiresAt - 60_000) return _token;

  if (!EMAIL || !PASSWORD) {
    throw new Error('ELIMAPI_EMAIL and ELIMAPI_PASSWORD must be set in .env');
  }

  const { data } = await axios.post(`${BASE_URL}/v1/auth/login`, { email: EMAIL, password: PASSWORD }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  _token     = data.access_token;
  _expiresAt = data.expires_in;   // API returns ms-epoch timestamp
  return _token;
}

function authHeaders() {
  return { Authorization: `Bearer ${_token}`, 'Content-Type': 'application/json' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search products.
 *
 * @param {string} keyword
 * @param {number} page
 * @param {number} pageSize
 * @param {object} filters   - { priceMin, priceMax, sort }
 * @returns {Promise<{products: Array, total: number}>}
 */
async function searchProducts(keyword, page = 1, pageSize = 20, filters = {}) {
  await getToken();

  const body = {
    q:        keyword,
    platform: 'alibaba',
    page,
    size:     pageSize,
    lang:     'en',
  };

  if (SORT_MAP[filters.sort]) body.sort = SORT_MAP[filters.sort];

  if (filters.priceMin || filters.priceMax) {
    body.filter = {
      price_range: {
        min: filters.priceMin ? Number(filters.priceMin) : undefined,
        max: filters.priceMax ? Number(filters.priceMax) : undefined,
      },
    };
  }

  const { data } = await axios.post(`${BASE_URL}/v1/products/search`, body, {
    headers: authHeaders(),
    timeout: 20000,
  });

  return {
    products: (data.items || []).map(normaliseProduct),
    total:    data.paginate?.total || 0,
  };
}

/**
 * Fetch full details for a single product by its ID.
 *
 * @param {string|number} productId
 * @returns {Promise<object>}
 */
async function getProductDetail(productId) {
  await getToken();

  const { data } = await axios.post(`${BASE_URL}/v1/products/detail`, {
    id:       productId,
    platform: 'alibaba',
    lang:     'en',
  }, {
    headers: authHeaders(),
    timeout: 20000,
  });

  return normaliseProduct(data);
}

// ---------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------

function normaliseProduct(item) {
  return {
    id:          String(item.id ?? ''),
    title:       item.titleEn     || item.title || '',
    titleCn:     item.title       || '',
    imageUrl:    item.img_url     || (Array.isArray(item.img_urls) ? item.img_urls[0] : '') || '',
    images:      Array.isArray(item.img_urls) ? item.img_urls : [],
    priceCny:    extractPrice(item),
    priceRange:  Array.isArray(item.price_range) ? item.price_range : [],
    minOrder:    item.moq || 1,
    unit:        item.unit        || 'piece',
    supplier:    item.shop_name   || item.seller_type || '',
    location:    item.level       || '',
    url:         item.link        || '',
    sales:       Number(item.sales_volume ?? item.sold ?? 0),
    rating:      null,
    attributes:  Array.isArray(item.attributes) ? item.attributes : [],
    description: item.description || '',
  };
}

function extractPrice(item) {
  const raw = item.promotion_price ?? item.price ?? item.retail_price;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return parseFloat(raw) || 0;
  return 0;
}

module.exports = { searchProducts, getProductDetail };
