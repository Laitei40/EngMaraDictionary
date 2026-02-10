/**
 * English ⇄ Mara Dictionary — Frontend Application
 *
 * Modules:
 *  - Config:       API endpoint, timeouts, limits
 *  - Cache:        IndexedDB + localStorage offline-first cache
 *  - Network:      Connection detection and status management
 *  - API:          Fetch layer with cache integration
 *  - UI:           DOM rendering, events, search logic
 *  - RecentSearch: Recent search history persistence
 *  - App:          Bootstrap and initialization
 */

'use strict';

// ─── Config ──────────────────────────────────────────────────────────
const Config = Object.freeze({
  // Change this to your deployed Cloudflare Worker URL
  API_BASE: 'http://localhost:8787',

  DEBOUNCE_MS:        300,
  CACHE_TTL_MS:       7 * 24 * 60 * 60 * 1000, // 7 days
  MAX_RECENT:         20,
  MIN_QUERY_LENGTH:   1,
  DB_NAME:            'MaraDictCache',
  DB_VERSION:         1,
  STORE_NAME:         'searches',
  RECENT_KEY:         'mara_dict_recent',
  ONLINE_CHECK_INTERVAL: 10_000,
});


// ─── Cache (IndexedDB + cookie metadata) ─────────────────────────────
const Cache = (() => {
  let db = null;

  /** Open or create the IndexedDB database. */
  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(Config.DB_NAME, Config.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const store = e.target.result.createObjectStore(Config.STORE_NAME, { keyPath: 'cacheKey' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /** Build a deterministic cache key from query + language. */
  function buildKey(query, lang) {
    return `${lang}:${query.toLowerCase().trim()}`;
  }

  /** Write a search result into the cache. */
  async function put(query, lang, data) {
    try {
      const store = (await open())
        .transaction(Config.STORE_NAME, 'readwrite')
        .objectStore(Config.STORE_NAME);
      const record = {
        cacheKey:  buildKey(query, lang),
        query:     query.toLowerCase().trim(),
        lang,
        data,
        timestamp: Date.now(),
      };
      store.put(record);
      _setCookieFlag(query, lang);
    } catch { /* silently ignore cache write errors */ }
  }

  /** Retrieve a cached result if it exists and is not expired. */
  async function get(query, lang) {
    try {
      const store = (await open())
        .transaction(Config.STORE_NAME, 'readonly')
        .objectStore(Config.STORE_NAME);
      return new Promise((resolve) => {
        const req = store.get(buildKey(query, lang));
        req.onsuccess = () => {
          const record = req.result;
          if (!record) return resolve(null);
          if (Date.now() - record.timestamp > Config.CACHE_TTL_MS) {
            _deleteKey(record.cacheKey);
            return resolve(null);
          }
          resolve(record);
        };
        req.onerror = () => resolve(null);
      });
    } catch { return null; }
  }

  /** Delete a single entry by key. */
  async function _deleteKey(key) {
    try {
      const store = (await open())
        .transaction(Config.STORE_NAME, 'readwrite')
        .objectStore(Config.STORE_NAME);
      store.delete(key);
    } catch { /* ignore */ }
  }

  /** Purge all expired entries. */
  async function purgeExpired() {
    try {
      const store = (await open())
        .transaction(Config.STORE_NAME, 'readwrite')
        .objectStore(Config.STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (Date.now() - cursor.value.timestamp > Config.CACHE_TTL_MS) {
          cursor.delete();
        }
        cursor.continue();
      };
    } catch { /* ignore */ }
  }

  /** Set a lightweight cookie flag indicating cached data exists. */
  function _setCookieFlag(query, lang) {
    const key = buildKey(query, lang);
    const encoded = encodeURIComponent(key);
    const maxAge = Math.floor(Config.CACHE_TTL_MS / 1000);
    document.cookie = `dc_${encoded}=1; max-age=${maxAge}; path=/; SameSite=Lax`;
  }

  /** Check cookie flag. */
  function hasCookieFlag(query, lang) {
    const key = encodeURIComponent(buildKey(query, lang));
    return document.cookie.includes(`dc_${key}=1`);
  }

  return { open, put, get, purgeExpired, hasCookieFlag };
})();


// ─── Network ─────────────────────────────────────────────────────────
const Network = (() => {
  let _online = navigator.onLine;
  const _listeners = [];

  function isOnline() { return _online; }

  function onChange(fn) { _listeners.push(fn); }

  function _notify() { _listeners.forEach((fn) => fn(_online)); }

  function init() {
    window.addEventListener('online',  () => { _online = true;  _notify(); });
    window.addEventListener('offline', () => { _online = false; _notify(); });

    // Periodic real connectivity check
    setInterval(async () => {
      try {
        const r = await fetch(`${Config.API_BASE}/api/health`, {
          method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(4000),
        });
        if (!_online && r.ok) { _online = true; _notify(); }
      } catch {
        if (_online && !navigator.onLine) { _online = false; _notify(); }
      }
    }, Config.ONLINE_CHECK_INTERVAL);
  }

  return { isOnline, onChange, init };
})();


// ─── API ─────────────────────────────────────────────────────────────
const API = (() => {
  let _controller = null;

  /**
   * Search the dictionary. Returns { results, fromCache }.
   * Falls back to cache when offline or on network error.
   */
  async function search(query, lang) {
    query = query.trim();
    if (query.length < Config.MIN_QUERY_LENGTH) return { results: [], fromCache: false };

    // Abort any in-flight request
    if (_controller) _controller.abort();
    _controller = new AbortController();

    // Try cache-first strategy
    const cached = await Cache.get(query, lang);

    if (!Network.isOnline()) {
      return cached
        ? { results: cached.data, fromCache: true }
        : { results: [], fromCache: false, offline: true };
    }

    // Online: fetch from API, fall back to cache on failure
    try {
      const url = `${Config.API_BASE}/api/search?q=${encodeURIComponent(query)}&lang=${lang}`;
      const res = await fetch(url, {
        signal: _controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      const results = json.results || json.data || json || [];

      // Update cache in background
      Cache.put(query, lang, results);

      return { results, fromCache: false };
    } catch (err) {
      if (err.name === 'AbortError') throw err; // let caller ignore aborted
      // Network error — try cache
      if (cached) return { results: cached.data, fromCache: true };
      return { results: [], fromCache: false, error: err.message };
    }
  }

  return { search };
})();


// ─── Recent Searches ─────────────────────────────────────────────────
const RecentSearches = (() => {
  function _load() {
    try {
      return JSON.parse(localStorage.getItem(Config.RECENT_KEY)) || [];
    } catch { return []; }
  }

  function _save(list) {
    try { localStorage.setItem(Config.RECENT_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  }

  function add(query, lang) {
    const q = query.trim().toLowerCase();
    if (!q) return;
    let list = _load().filter((item) => !(item.q === q && item.lang === lang));
    list.unshift({ q, lang, ts: Date.now() });
    if (list.length > Config.MAX_RECENT) list = list.slice(0, Config.MAX_RECENT);
    _save(list);
  }

  function getAll() { return _load(); }

  function clear() { _save([]); }

  return { add, getAll, clear };
})();


// ─── UI ──────────────────────────────────────────────────────────────
const UI = (() => {
  // DOM refs
  const $searchInput     = document.getElementById('search-input');
  const $searchForm      = document.getElementById('search-form');
  const $resultsContainer= document.getElementById('results-container');
  const $resultsCount    = document.getElementById('results-count');
  const $statusMessage   = document.getElementById('status-message');
  const $offlineBadge    = document.getElementById('offline-badge');
  const $recentSection   = document.getElementById('recent-section');
  const $recentList      = document.getElementById('recent-list');
  const $langBtns        = document.querySelectorAll('.lang-btn');

  let _currentLang    = 'en';
  let _debounceTimer  = null;
  let _lastQuery      = '';

  // ── Rendering helpers ──

  function _setStatus(text, type = 'info') {
    $statusMessage.textContent = text;
    $statusMessage.className = `alert ${type}`;
    $statusMessage.classList.remove('hidden');
  }

  function _clearStatus() {
    $statusMessage.classList.add('hidden');
    $statusMessage.textContent = '';
    $resultsCount.classList.add('hidden');
  }

  function _showLoading() {
    $resultsContainer.innerHTML = `
      <div class="loading-spinner"><div class="spinner"></div></div>
    `;
  }

  function _renderEmpty(query) {
    $resultsCount.classList.add('hidden');
    $resultsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </div>
        <div class="empty-state-text">No results for \u201c${_escapeHtml(query)}\u201d</div>
        <div class="empty-state-hint">Check your spelling or try searching in the other direction.</div>
      </div>
    `;
  }

  function _renderWelcome() {
    $resultsCount.classList.add('hidden');
    $resultsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>
        </div>
        <div class="empty-state-text">Start searching</div>
        <div class="empty-state-hint">Type an English or Mara word above to find its translation.</div>
      </div>
    `;
  }

  function _renderResults(results, lang, fromCache) {
    if (!results.length) return;

    const isEnToMara = lang === 'en';

    // Show result count
    const countText = results.length === 1 ? '1 result' : `${results.length} results`;
    $resultsCount.textContent = countText;
    $resultsCount.classList.remove('hidden');

    const html = results.map((entry) => {
      const sourceWord = isEnToMara ? entry.english_word : entry.mara_word;
      const targetWord = isEnToMara ? entry.mara_word : entry.english_word;
      const targetLabel = isEnToMara ? 'Mara' : 'English';

      let cardBody = `
        <div class="result-header">
          <span class="result-word">${_escapeHtml(sourceWord)}</span>
          ${entry.part_of_speech ? `<span class="result-pos">${_escapeHtml(entry.part_of_speech)}</span>` : ''}
        </div>
        <hr class="result-divider">
        <div class="result-translation-wrap">
          <span class="result-label">${targetLabel}</span>
          <span class="result-translation">${_escapeHtml(targetWord)}</span>
        </div>
      `;

      if (entry.definition) {
        cardBody += `<div class="result-definition">${_escapeHtml(entry.definition)}</div>`;
      }

      if (entry.example_sentence) {
        cardBody += `<div class="result-example">\u201c${_escapeHtml(entry.example_sentence)}\u201d</div>`;
      }

      return `<article class="result-card">${cardBody}</article>`;
    }).join('');

    $resultsContainer.innerHTML = html;

    if (fromCache) {
      _setStatus('Showing cached results \u2014 you appear to be offline.', 'cache-notice');
    } else {
      _clearStatus();
      // Keep count visible
      $resultsCount.classList.remove('hidden');
    }
  }

  function _renderRecent() {
    const recent = RecentSearches.getAll();
    if (!recent.length) {
      $recentSection.classList.add('hidden');
      return;
    }
    $recentSection.classList.remove('hidden');
    $recentList.innerHTML = recent.map((item) => `
      <li>
        <button class="recent-item" data-query="${_escapeAttr(item.q)}" data-lang="${item.lang}">
          <span class="recent-item-lang">${item.lang === 'en' ? 'EN' : 'MRH'}</span>
          ${_escapeHtml(item.q)}
        </button>
      </li>
    `).join('');
  }

  function _escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function _escapeAttr(str) {
    return _escapeHtml(str);
  }

  // ── Offline badge ──

  function _updateOfflineBadge(online) {
    if (online) {
      $offlineBadge.classList.add('hidden');
    } else {
      $offlineBadge.classList.remove('hidden');
    }
  }

  // ── Search execution ──

  async function _executeSearch(query) {
    query = query.trim();
    if (query.length < Config.MIN_QUERY_LENGTH) {
      _clearStatus();
      _renderWelcome();
      _lastQuery = '';
      return;
    }

    if (query === _lastQuery) return;
    _lastQuery = query;

    _showLoading();
    _clearStatus();

    try {
      const { results, fromCache, offline, error } = await API.search(query, _currentLang);

      // Guard against stale result render
      if (query !== _lastQuery) return;

      if (error && !results.length) {
        _setStatus('Unable to reach the dictionary. Please try again.', 'error');
        _renderEmpty(query);
        return;
      }

      if (offline && !results.length) {
        _setStatus('You are offline and no cached results are available for this word.', 'warning');
        _renderEmpty(query);
        return;
      }

      if (!results.length) {
        _renderEmpty(query);
        return;
      }

      _renderResults(results, _currentLang, fromCache);
      RecentSearches.add(query, _currentLang);
      _renderRecent();
    } catch (err) {
      if (err.name === 'AbortError') return;
      _setStatus('Something went wrong. Please try again.', 'error');
    }
  }

  // ── Event wiring ──

  function _onInput() {
    clearTimeout(_debounceTimer);
    const query = $searchInput.value;
    if (!query.trim()) {
      _clearStatus();
      _renderWelcome();
      _lastQuery = '';
      _renderRecent();
      return;
    }
    _debounceTimer = setTimeout(() => _executeSearch(query), Config.DEBOUNCE_MS);
  }

  function _onSubmit(e) {
    e.preventDefault();
    clearTimeout(_debounceTimer);
    _lastQuery = ''; // force re-search
    _executeSearch($searchInput.value);
  }

  function _onLangSwitch(e) {
    const btn = e.target.closest('.lang-btn');
    if (!btn) return;
    _currentLang = btn.dataset.lang;
    $langBtns.forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', String(isActive));
    });
    // Re-run search with new language if there's a query
    if ($searchInput.value.trim()) {
      _lastQuery = ''; // force re-search
      _executeSearch($searchInput.value);
    }
  }

  function _onRecentClick(e) {
    const btn = e.target.closest('.recent-item');
    if (!btn) return;
    const query = btn.dataset.query;
    const lang  = btn.dataset.lang;

    // Set language
    _currentLang = lang;
    $langBtns.forEach((b) => {
      const isActive = b.dataset.lang === lang;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', String(isActive));
    });

    // Set input and search
    $searchInput.value = query;
    _lastQuery = '';
    _executeSearch(query);
  }

  // ── Connection status change handler ──

  function _onNetworkChange(online) {
    _updateOfflineBadge(online);
    if (online && _lastQuery) {
      // Silently refresh current results from API
      _executeSearch(_lastQuery);
    }
  }

  // ── Init ──

  function init() {
    // Event listeners
    $searchInput.addEventListener('input', _onInput);
    $searchForm.addEventListener('submit', _onSubmit);
    $langBtns.forEach((btn) => btn.addEventListener('click', _onLangSwitch));
    $recentList.addEventListener('click', _onRecentClick);

    // Network status
    Network.onChange(_onNetworkChange);
    _updateOfflineBadge(Network.isOnline());

    // Initial state
    _renderWelcome();
    _renderRecent();
  }

  return { init };
})();


// ─── App (Bootstrap) ─────────────────────────────────────────────────
const App = (() => {
  async function init() {
    try {
      await Cache.open();
      Cache.purgeExpired();
    } catch {
      console.warn('IndexedDB unavailable — cache disabled.');
    }

    Network.init();
    UI.init();
  }

  return { init };
})();

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
