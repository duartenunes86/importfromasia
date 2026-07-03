/* ===================================================================
   ImportFromAsia — Frontend Application
=================================================================== */

const API_BASE = '/api';

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------
let currentQuery    = '';
let currentPage     = 1;
let currentTotal    = 0;
let currentProducts = [];
let currentCurrency = null;   // null until geo-detected
let currentSymbol   = '$';
let sortMode        = 'default';
let currentPageSize = 50;
let filterPriceMin  = null;
let filterPriceMax  = null;

// Saved products — persisted in localStorage
const SAVED_KEY = 'ifa_saved_products';

// -----------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------
const EU_COUNTRIES = new Set([
  'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR',
  'HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK',
]);

async function detectCurrency() {
  // Prices are shown in British pounds (GBP) for all visitors.
  return { currency: 'GBP', symbol: '£' };
}

document.addEventListener('DOMContentLoaded', async () => {
  // Detect currency from real browser IP before first search
  const geo = await detectCurrency();
  currentCurrency = geo.currency;
  currentSymbol   = geo.symbol;
  updateCurrencyBadge(currentCurrency, currentSymbol);

  bindEvents();
  refreshSavedBadge();

  // Restore search from URL (e.g. after browser back)
  const params = new URLSearchParams(window.location.search);
  const q = params.get('q');
  if (q) {
    document.getElementById('searchInput').value = q;
    currentPage = parseInt(params.get('page')) || 1;
    runSearch(q, currentPage);
  }
});

// -----------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------
function bindEvents() {
  // Hero search
  document.getElementById('searchForm').addEventListener('submit', e => {
    e.preventDefault();
    const q = document.getElementById('searchInput').value.trim();
    if (q) triggerSearch(q, 1);
  });

    // Header search
    document.getElementById('searchFormHeader').addEventListener('submit', e => {
      e.preventDefault();
      const q = document.getElementById('headerSearchInput').value.trim();
      if (q) triggerSearch(q, 1);
    });

    // Logo → back to hero
    document.getElementById('logoLink').addEventListener('click', e => {
      e.preventDefault();
      showHero();
      window.history.pushState({}, '', '/');
    });

  // Quick-search chips
  document.querySelectorAll('.tag-chip').forEach(chip =>
    chip.addEventListener('click', () => triggerSearch(chip.dataset.query, 1))
  );

  // Sort — relevance (single batch) vs price low→high (pooled + sorted)
  document.getElementById('sortSelect').addEventListener('change', e => {
    sortMode = e.target.value;
    if (currentQuery) triggerSearch(currentQuery, 1);
  });

  // Price filters
  document.getElementById('applyFiltersBtn').addEventListener('click', () => {
    filterPriceMin = parseFloat(document.getElementById('priceMin').value) || null;
    filterPriceMax = parseFloat(document.getElementById('priceMax').value) || null;
    if (currentQuery) triggerSearch(currentQuery, 1);
  });
  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    document.getElementById('priceMin').value = '';
    document.getElementById('priceMax').value = '';
    filterPriceMin = null;
    filterPriceMax = null;
    if (currentQuery) triggerSearch(currentQuery, 1);
  });

  // Modal close
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('productModal').addEventListener('click', e => {
    if (e.target === document.getElementById('productModal')) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); closeSavedPanel(); }
  });

  // Saved panel — clear all
  document.getElementById('clearSavedBtn').addEventListener('click', () => {
    if (confirm('Remove all saved products?')) {
      localStorage.removeItem(SAVED_KEY);
      refreshSavedBadge();
      renderSavedList();
    }
  });
}

// -----------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------
function triggerSearch(query, page = 1) {
  currentQuery = query;
  currentPage  = page;
  document.getElementById('searchInput').value       = query;
  document.getElementById('headerSearchInput').value  = query;
  const url = new URL(window.location);
  url.searchParams.set('q', query);
  url.searchParams.set('page', page);
  window.history.pushState({}, '', url);
  runSearch(query, page);
}

async function runSearch(query, page) {
  showResultsSection();
  showSkeleton();

  // Pass price filters converted back to CNY for the API
  // (API takes CNY prices; we show local-currency inputs so convert if rates available)
  const params = new URLSearchParams({
    q:        query,
    page,
    sort:     sortMode,
  });
  if (currentCurrency)       params.set('currency', currentCurrency);
  if (filterPriceMin != null) params.set('priceMin', filterPriceMin);
  if (filterPriceMax != null) params.set('priceMax', filterPriceMax);

  try {
    const resp = await fetch(`${API_BASE}/search?${params}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();

    // Backend returns results already ordered for the chosen sort mode
    currentProducts = data.products || [];
    currentTotal    = data.total    || 0;
    currentPageSize = data.pageSize || currentPageSize;
    currentCurrency = data.currency || currentCurrency;
    currentSymbol   = data.symbol   || currentSymbol;

    // Update filter currency labels
    document.querySelectorAll('.filter-label span[id^="filterCurrencyLabel"]')
      .forEach(el => { el.textContent = currentSymbol; });

    updateCurrencyBadge(currentCurrency, currentSymbol);
    updateResultsMeta(query, currentTotal);
    renderProducts(currentProducts);
    renderPagination(currentTotal, page);

  } catch (err) {
    showError(err.message);
  }
}

function retrySearch() {
  if (currentQuery) runSearch(currentQuery, currentPage);
}

// -----------------------------------------------------------------------
// Render products
// -----------------------------------------------------------------------
function renderProducts(products) {
  const grid = document.getElementById('productGrid');
  hideSkeleton();
  hideError();

  if (!products.length) {
    showEmptyState();
    grid.innerHTML = '';
    document.getElementById('pagination').style.display = 'none';
    return;
  }

  hideEmptyState();
  const saved = getSaved();
  grid.innerHTML = products.map((p, i) => buildCard(p, i, saved)).join('');

  // Click handlers
  grid.querySelectorAll('.product-card').forEach((card, i) => {
    card.addEventListener('click', e => {
      if (e.target.closest('.save-btn')) return; // handled separately
      openProductModal(products[i]);
    });
  });

  // Save button handlers
  grid.querySelectorAll('.save-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      toggleSave(products[idx], btn);
    });
  });
}

function buildCard(product, idx, saved) {
  const isSaved  = saved.some(s => s.id === product.id);
  const imageHtml = product.imageUrl
    ? `<img src="${escHtml(product.imageUrl)}" alt="${escHtml(product.title)}" loading="lazy"
         onerror="this.parentElement.innerHTML='<div class=card-img-placeholder>📦</div>'">`
    : `<div class="card-img-placeholder">📦</div>`;

  const priceHtml = product.price
    ? `<div class="card-price">${escHtml(product.price.formatted)}</div>`
    : `<div class="card-price" style="color:var(--text-muted);font-size:14px;">Price on request</div>`;

  return `
    <article class="product-card" tabindex="0" role="button" style="position:relative;">
      <button class="save-btn ${isSaved ? 'saved' : ''}" data-idx="${idx}" title="${isSaved ? 'Remove from saved' : 'Save product'}" aria-label="Save">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
      <div class="card-image-wrap">${imageHtml}</div>
      <div class="card-body">
        <h3 class="card-title">${escHtml(product.title)}</h3>
        ${priceHtml}
        <p class="card-meta">${escHtml(product.supplier || '')}</p>
      </div>
      <div class="card-footer">
        <span class="card-moq">MOQ: ${product.minOrder || 1} ${escHtml(product.unit || 'pcs')}</span>
        ${product.sales ? `<span class="card-sales">${formatNumber(product.sales)} sold</span>` : ''}
      </div>
    </article>`;
}

// -----------------------------------------------------------------------
// Pagination
// -----------------------------------------------------------------------
function renderPagination(total, cur) {
  const pages     = Math.ceil(total / currentPageSize);
  const el        = document.getElementById('pagination');
  if (pages <= 1) { el.style.display = 'none'; return; }
  el.style.display = 'flex';

  const range = [];
  range.push(1);
  if (cur > 3) range.push('…');
  for (let i = Math.max(2, cur - 1); i <= Math.min(pages - 1, cur + 1); i++) range.push(i);
  if (cur < pages - 2) range.push('…');
  range.push(pages);

  el.innerHTML =
    `<button class="page-btn" onclick="triggerSearch('${esc(currentQuery)}',${cur-1})" ${cur===1?'disabled':''}>&#8592;</button>` +
    range.map(p => p === '…'
      ? `<span class="page-btn" style="cursor:default">…</span>`
      : `<button class="page-btn ${p===cur?'active':''}" onclick="triggerSearch('${esc(currentQuery)}',${p})">${p}</button>`
    ).join('') +
    `<button class="page-btn" onclick="triggerSearch('${esc(currentQuery)}',${cur+1})" ${cur===pages?'disabled':''}>&#8594;</button>`;

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// -----------------------------------------------------------------------
// Product modal
// -----------------------------------------------------------------------
function openProductModal(product) {
  const saved   = getSaved();
  const isSaved = saved.some(s => s.id === product.id);
  const modal   = document.getElementById('productModal');
  const content = document.getElementById('modalContent');

  modal.dataset.productId = product.id;
  modal._product = product;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Render immediately with card data, then load detail
  renderModal(content, product, isSaved, null);

  // Fetch full detail in background
  const detailUrl = `/api/product/${encodeURIComponent(product.id)}${currentCurrency ? '?currency='+currentCurrency : ''}`;
  fetch(detailUrl)
    .then(r => r.json())
    .then(detail => {
      if (modal.dataset.productId !== product.id) return; // modal was closed/changed
      renderModal(content, { ...product, ...detail }, isSaved, detail);
    })
    .catch(() => {}); // silently fail — card data already showing
}

function renderModal(content, product, isSaved, detail) {
  const images = detail?.images?.length ? detail.images : (product.imageUrl ? [product.imageUrl] : []);

  const galleryHtml = images.length
    ? `<div class="modal-gallery">${images.map((url, i) =>
        `<img src="${escHtml(url)}" alt="${escHtml(product.title)}" loading="${i===0?'eager':'lazy'}"
              class="modal-gallery-img ${i===0?'active':''}" onclick="selectGalleryImg(this)">`
      ).join('')}</div>`
    : `<div class="card-img-placeholder" style="height:220px;background:#f3f4f6;border-radius:8px;">📦</div>`;

  const priceBlock = product.price
    ? `<div class="modal-price">${escHtml(product.price.formatted)}</div>`
    : `<div class="modal-price" style="color:var(--text-secondary);font-size:20px;">Price on request</div>`;

  // Tiered pricing (price_range)
  let tierHtml = '';
  if (detail?.priceRange?.length > 1) {
    tierHtml = `<div class="modal-tiers">
      ${detail.priceRange.map(t => {
        const converted = product.price && product.priceCny
          ? (t.price / product.priceCny * product.price.amount).toFixed(2)
          : t.price.toFixed(2);
        return `<div class="tier-row">
          <span class="tier-moq">${t.moq}+ units</span>
          <span class="tier-price">${product.price?.symbol || '¥'}${converted}</span>
        </div>`;
      }).join('')}
    </div>`;
  }

  // Attributes table
  let attrsHtml = '';
  if (detail?.attributes?.length) {
    attrsHtml = `<div class="modal-attrs">
      ${detail.attributes.map(a =>
        `<span class="attr-label">${escHtml(a.nameEn || a.name)}</span>
         <span class="attr-value">${escHtml(a.valueEn || a.value)}</span>`
      ).join('')}
    </div>`;
  }

  // Description HTML (already sanitised by backend)
  const descHtml = detail?.description
    ? `<div class="modal-description">${detail.description}</div>`
    : (!detail ? `<div class="modal-desc-loading">Loading description…</div>` : '');

  content.innerHTML = `
    ${galleryHtml}
    <h2 class="modal-title">${escHtml(product.title)}</h2>
    ${priceBlock}
    ${tierHtml}
    <div class="modal-specs">
      <span class="modal-spec-label">Min. Order</span>
      <span class="modal-spec-value">${product.minOrder || 1} ${escHtml(product.unit || 'pieces')}</span>
      ${product.supplier ? `<span class="modal-spec-label">Supplier</span><span class="modal-spec-value">${escHtml(product.supplier)}</span>` : ''}
      ${product.sales    ? `<span class="modal-spec-label">Sold</span><span class="modal-spec-value">${formatNumber(product.sales)} units</span>` : ''}
    </div>
    ${attrsHtml}
    ${descHtml}
    <div class="modal-actions">
      <button class="btn btn-outline btn-lg" id="modalSaveBtn" onclick="toggleSaveFromModal('${escHtml(product.id)}')">
        ${isSaved ? '✓ Saved' : '+ Save'}
      </button>
      <button class="btn btn-ghost btn-lg" onclick="closeModal()">Close</button>
    </div>`;
}

function selectGalleryImg(el) {
  el.closest('.modal-gallery').querySelectorAll('.modal-gallery-img').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
}

function closeModal() {
  document.getElementById('productModal').style.display = 'none';
  document.body.style.overflow = '';
}

// -----------------------------------------------------------------------
// Save / Favourites
// -----------------------------------------------------------------------
function getSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); }
  catch { return []; }
}

function setSaved(list) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(list));
}

function toggleSave(product, btn) {
  let saved = getSaved();
  const exists = saved.findIndex(s => s.id === product.id);
  if (exists >= 0) {
    saved.splice(exists, 1);
    btn?.classList.remove('saved');
    if (btn) btn.querySelector('svg').setAttribute('fill', 'none');
    btn?.setAttribute('title', 'Save product');
  } else {
    saved.push({
      id:       product.id,
      title:    product.title,
      imageUrl: product.imageUrl,
      price:    product.price,
      priceCny: product.priceCny,
      url:      product.url,
      minOrder: product.minOrder,
      unit:     product.unit,
    });
    btn?.classList.add('saved');
    if (btn) btn.querySelector('svg').setAttribute('fill', 'currentColor');
    btn?.setAttribute('title', 'Remove from saved');
  }
  setSaved(saved);
  refreshSavedBadge();
}

function toggleSaveFromModal(productId) {
  const modal   = document.getElementById('productModal');
  const product = modal._product;
  if (!product) return;
  toggleSave(product, null);
  // Update button label
  const btn  = document.getElementById('modalSaveBtn');
  const saved = getSaved();
  const now   = saved.some(s => s.id === productId);
  if (btn) btn.textContent = now ? '✓ Saved' : '+ Save';
}

function refreshSavedBadge() {
  const saved = getSaved();
  const count = saved.length;
  const btn   = document.getElementById('savedBtn');
  const badge = document.getElementById('savedCount');
  btn.style.display  = 'flex';
  badge.textContent  = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

function openSavedPanel() {
  renderSavedList();
  document.getElementById('savedPanel').style.display   = 'flex';
  document.getElementById('savedOverlay').style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function closeSavedPanel() {
  document.getElementById('savedPanel').style.display   = 'none';
  document.getElementById('savedOverlay').style.display = 'none';
  document.body.style.overflow = '';
}

function renderSavedList() {
  const saved = getSaved();
  const list  = document.getElementById('savedList');

  if (!saved.length) {
    list.innerHTML = `<div class="saved-empty"><div class="empty-icon">🔖</div><p>No saved products yet.<br>Click the bookmark icon on any product.</p></div>`;
    return;
  }

  list.innerHTML = saved.map(p => `
    <div class="saved-item" onclick="savedItemClick('${escHtml(p.id)}')">
      ${p.imageUrl
        ? `<img class="saved-item-img" src="${escHtml(p.imageUrl)}" alt="${escHtml(p.title)}"
             onerror="this.outerHTML='<div class=saved-item-img saved-item-placeholder>📦</div>'">`
        : `<div class="saved-item-img saved-item-placeholder">📦</div>`}
      <div class="saved-item-info">
        <div class="saved-item-title">${escHtml(p.title)}</div>
        ${p.price ? `<div class="saved-item-price">${escHtml(p.price.formatted)}</div>` : ''}
      </div>
      <button class="saved-item-remove" onclick="removeSaved(event,'${escHtml(p.id)}')" title="Remove">×</button>
    </div>`).join('');
}

function savedItemClick(id) {
  const saved   = getSaved();
  const product = saved.find(s => s.id === id);
  if (product?.url) window.open(product.url, '_blank', 'noopener');
}

function removeSaved(e, id) {
  e.stopPropagation();
  const saved = getSaved().filter(s => s.id !== id);
  setSaved(saved);
  refreshSavedBadge();
  renderSavedList();
  // Also update save button in grid if visible
  const btn = document.querySelector(`.save-btn[data-idx]`);
  // Re-render grid to update all bookmark icons
  renderProducts(currentProducts);
}

// -----------------------------------------------------------------------
// UI state
// -----------------------------------------------------------------------
function showHero() {
  document.getElementById('heroSection').style.display     = '';
  document.getElementById('resultsSection').style.display  = 'none';
  document.getElementById('searchFormHeader').style.display = 'none';
  document.getElementById('currencyBadge').innerHTML       = '';
}

function showResultsSection() {
  document.getElementById('heroSection').style.display     = 'none';
  document.getElementById('resultsSection').style.display  = 'block';
  document.getElementById('searchFormHeader').style.display = 'flex';
  document.getElementById('savedBtn').style.display        = 'flex';
}

function showSkeleton() {
  const skel = document.getElementById('loadingSkeleton');
  const tmpl = document.getElementById('skeletonTemplate');
  skel.innerHTML = '';
  for (let i = 0; i < 8; i++) skel.appendChild(tmpl.cloneNode(true));
  skel.style.display = 'grid';
  document.getElementById('productGrid').innerHTML = '';
  document.getElementById('errorState').style.display  = 'none';
  document.getElementById('emptyState').style.display  = 'none';
  document.getElementById('pagination').style.display  = 'none';
}

function hideSkeleton() { document.getElementById('loadingSkeleton').style.display = 'none'; }

function showError(msg) {
  hideSkeleton();
  document.getElementById('errorTitle').textContent   = 'Something went wrong';
  document.getElementById('errorMessage').textContent = msg || 'Please try again.';
  document.getElementById('errorState').style.display  = 'block';
  document.getElementById('productGrid').innerHTML     = '';
  document.getElementById('pagination').style.display  = 'none';
}

function hideError()      { document.getElementById('errorState').style.display = 'none'; }
function showEmptyState() { document.getElementById('emptyState').style.display = 'block'; }
function hideEmptyState() { document.getElementById('emptyState').style.display = 'none'; }

function updateCurrencyBadge(currency, symbol) {
  const flags = { GBP: '🇬🇧', EUR: '🇪🇺', USD: '🇺🇸' };
  document.getElementById('currencyBadge').innerHTML =
    `<span class="currency-badge">${flags[currency] || ''} ${currency}</span>`;
  // Keep filter labels in sync
  document.getElementById('filterCurrencyLabel').textContent  = symbol;
  document.getElementById('filterCurrencyLabel2').textContent = symbol;
}

function updateResultsMeta(query, total) {
  document.getElementById('resultsMeta').innerHTML =
    `Results for <strong>${escHtml(query)}</strong> · ${formatNumber(total)} products`;
}

// -----------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------
function escHtml(str) {
  if (typeof str !== 'string') return str ?? '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Lighter version for inline onclick values (no HTML encoding needed, just JS string safety)
function esc(str) {
  return (str || '').replace(/'/g, "\\'");
}

function formatNumber(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
