/**
 * Currency Service
 *
 * - Fetches live CNY exchange rates from Frankfurter (free, no API key).
 * - Caches rates for 1 hour to avoid hammering the API.
 * - Applies a 15% spread (markup) on top of the mid-market rate.
 * - Detects the user's currency from their IP using ip-api.com (free).
 *
 * Currency rules:
 *   UK    → GBP
 *   EU*   → EUR
 *   Other → USD
 *
 * * EU countries: AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT
 *                 LT LU LV MT NL PL PT RO SE SI SK
 */

const axios    = require('axios');
const NodeCache = require('node-cache');

const rateCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const geoCache  = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

const SPREAD = 0.15; // 15%

const EU_COUNTRIES = new Set([
  'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR',
  'HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK',
]);

/**
 * Determine which currency to show based on an IP address.
 *
 * @param {string} ip
 * @returns {Promise<{currency: 'GBP'|'EUR'|'USD', country: string, symbol: string}>}
 */
async function getCurrencyForIp(ip) {
  const cacheKey = `geo:${ip}`;
  const cached = geoCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let countryCode = 'US';

  try {
    // ip-api.com free tier: 1000 requests/min, no API key needed.
    // Use HTTPS with the pro endpoint if you have a key.
    const { data } = await axios.get(`http://ip-api.com/json/${ip}?fields=countryCode`, {
      timeout: 5000,
    });
    if (data?.countryCode) {
      countryCode = data.countryCode;
    }
  } catch {
    // Fall back to USD if geolocation fails
  }

  const result = resolveCurrency(countryCode);
  geoCache.set(cacheKey, result);
  return result;
}

/**
 * Convert a price from CNY to the target currency, then apply the 15% spread
 * to the converted price (not to the rate).
 *
 * Steps:
 *   1. Convert at the real mid-market rate:  basePrice = cnyAmount × rate
 *   2. Add 15% markup to the price:          finalPrice = basePrice × 1.15
 *
 * The exchange rate itself is never modified.
 *
 * @param {number} cnyAmount
 * @param {'GBP'|'EUR'|'USD'} targetCurrency
 * @returns {Promise<{amount: number, baseAmount: number, spread: number, formatted: string, currency: string, symbol: string}>}
 */
async function convertFromCny(cnyAmount, targetCurrency) {
  const rates = await getExchangeRates();
  const rate  = rates[targetCurrency];

  if (!rate) {
    throw new Error(`Exchange rate unavailable for ${targetCurrency}`);
  }

  const symbol    = currencySymbol(targetCurrency);

  // Step 1 — real converted price at mid-market rate
  const baseAmount = cnyAmount * rate;

  // Step 2 — 15% markup on the price
  const spreadAmount = baseAmount * SPREAD;
  const finalAmount  = baseAmount + spreadAmount;

  return {
    amount:     parseFloat(finalAmount.toFixed(2)),
    baseAmount: parseFloat(baseAmount.toFixed(2)),   // price without markup (for transparency)
    spread:     parseFloat(spreadAmount.toFixed(2)), // the markup amount
    formatted:  `${symbol}${finalAmount.toFixed(2)}`,
    currency:   targetCurrency,
    symbol,
    rate,                                            // real mid-market rate, untouched
  };
}

/**
 * Fetch exchange rates CNY → GBP, EUR, USD from Frankfurter.
 * Results are cached for 1 hour.
 *
 * @returns {Promise<{GBP: number, EUR: number, USD: number}>}
 */
async function getExchangeRates() {
  const cacheKey = 'rates:CNY';
  const cached = rateCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data } = await axios.get(
    'https://api.frankfurter.app/latest?from=CNY&to=GBP,EUR,USD',
    { timeout: 8000 }
  );

  const rates = data?.rates;
  if (!rates?.GBP || !rates?.EUR || !rates?.USD) {
    throw new Error('Unexpected response from Frankfurter exchange rate API');
  }

  rateCache.set(cacheKey, rates);
  return rates;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCurrency(countryCode) {
  if (countryCode === 'GB') {
    return { currency: 'GBP', country: countryCode, symbol: '£' };
  }
  if (EU_COUNTRIES.has(countryCode)) {
    return { currency: 'EUR', country: countryCode, symbol: '€' };
  }
  return { currency: 'USD', country: countryCode, symbol: '$' };
}

function currencySymbol(currency) {
  return { GBP: '£', EUR: '€', USD: '$' }[currency] || currency;
}

module.exports = { getCurrencyForIp, convertFromCny, getExchangeRates };
