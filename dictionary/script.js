/**
 * English ⇄ Mara Dictionary — Frontend Application
 *
 * Features:
 *  - Instant search with debounce
 *  - Autocomplete suggestions dropdown
 *  - URL routing (?q=word&lang=en) for shareable/bookmarkable links
 *  - Exact word lookup with grouped POS + related words
 *  - Alphabet browse (A–Z)
 *  - Share button per entry
 *  - Keyboard shortcut: / to focus search
 *  - Cookie consent banner
 *  - Offline-first caching (IndexedDB)
 *  - Recent search history
 *
 * Modules:
 *  - Config, Cache, Network, API, RecentSearches, CookieConsent, UI, App
 */

'use strict';

// ─── Config ──────────────────────────────────────────────────────────
const Config = Object.freeze({
  API_BASE: 'https://engmaradictionary.teiteipara.workers.dev',

  DEBOUNCE_MS:        300,
  SUGGEST_DEBOUNCE:   150,
  CACHE_TTL_MS:       7 * 24 * 60 * 60 * 1000,
  MAX_RECENT:         20,
  MIN_QUERY_LENGTH:   1,
  DB_NAME:            'MaraDictCache',
  DB_VERSION:         1,
  STORE_NAME:         'searches',
  RECENT_KEY:         'mara_dict_recent',
  COOKIE_ACCEPTED:    'mara_dict_cookie_ok',
  ONLINE_CHECK_INTERVAL: 10_000,
});


// ─── Cache (IndexedDB) ──────────────────────────────────────────────
const Cache = (() => {
  let db = null;

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

  function buildKey(query, lang) {
    return `${lang}:${query.toLowerCase().trim()}`;
  }

  async function put(query, lang, data) {
    try {
      const store = (await open())
        .transaction(Config.STORE_NAME, 'readwrite')
        .objectStore(Config.STORE_NAME);
      store.put({
        cacheKey:  buildKey(query, lang),
        query:     query.toLowerCase().trim(),
        lang, data,
        timestamp: Date.now(),
      });
    } catch { /* ignore */ }
  }

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

  async function _deleteKey(key) {
    try {
      const store = (await open())
        .transaction(Config.STORE_NAME, 'readwrite')
        .objectStore(Config.STORE_NAME);
      store.delete(key);
    } catch { /* ignore */ }
  }

  async function purgeExpired() {
    try {
      const store = (await open())
        .transaction(Config.STORE_NAME, 'readwrite')
        .objectStore(Config.STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (Date.now() - cursor.value.timestamp > Config.CACHE_TTL_MS) cursor.delete();
        cursor.continue();
      };
    } catch { /* ignore */ }
  }

  return { open, put, get, purgeExpired };
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

  async function search(query, lang) {
    query = query.trim();
    if (query.length < Config.MIN_QUERY_LENGTH) return { results: [], fromCache: false };

    if (_controller) _controller.abort();
    _controller = new AbortController();

    const cached = await Cache.get(query, lang);

    if (!Network.isOnline()) {
      return cached
        ? { results: cached.data, fromCache: true }
        : { results: [], fromCache: false, offline: true };
    }

    try {
      const url = `${Config.API_BASE}/api/search?q=${encodeURIComponent(query)}&lang=${lang}`;
      const res = await fetch(url, {
        signal: _controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const results = json.results || json.data || json || [];
      Cache.put(query, lang, results);
      return { results, fromCache: false };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (cached) return { results: cached.data, fromCache: true };
      return { results: [], fromCache: false, error: err.message };
    }
  }

  /** Fetch autocomplete suggestions */
  async function suggest(query, lang) {
    query = query.trim();
    if (query.length < 1) return [];
    try {
      const url = `${Config.API_BASE}/api/suggest?q=${encodeURIComponent(query)}&lang=${lang}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return [];
      const json = await res.json();
      return json.suggestions || [];
    } catch { return []; }
  }

  /** Fetch exact word data (definition page style) */
  async function word(query, lang) {
    query = query.trim();
    if (!query) return null;
    try {
      const url = `${Config.API_BASE}/api/word?q=${encodeURIComponent(query)}&lang=${lang}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  /** Browse words by letter */
  async function browse(letter, lang, page = 1) {
    try {
      const url = `${Config.API_BASE}/api/browse?letter=${encodeURIComponent(letter)}&lang=${lang}&page=${page}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  return { search, suggest, word, browse };
})();


// ─── Recent Searches ─────────────────────────────────────────────────
const RecentSearches = (() => {
  function _load() {
    try { return JSON.parse(localStorage.getItem(Config.RECENT_KEY)) || []; } catch { return []; }
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


// ─── Cookie Consent ──────────────────────────────────────────────────
const CookieConsent = (() => {
  function init() {
    if (localStorage.getItem(Config.COOKIE_ACCEPTED)) return;
    const banner = document.getElementById('cookie-banner');
    if (!banner) return;
    banner.classList.remove('hidden');
    document.getElementById('cookie-accept').addEventListener('click', () => {
      localStorage.setItem(Config.COOKIE_ACCEPTED, '1');
      banner.classList.add('hidden');
    });
  }
  return { init };
})();


// ─── Theme Toggle (Dark/Light Mode) ─────────────────────────────────
const ThemeToggle = (() => {
  const STORAGE_KEY = 'mara_dict_theme';

  function _getPreferred() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function _apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Update theme-color meta tag
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0f172a' : '#2563eb';
  }

  function toggle() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    _apply(next);
    localStorage.setItem(STORAGE_KEY, next);
  }

  function init() {
    // Apply saved/preferred theme
    _apply(_getPreferred());

    // Wire toggle button
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', toggle);

    // Listen for OS-level theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem(STORAGE_KEY)) {
        _apply(e.matches ? 'dark' : 'light');
      }
    });
  }

  return { init, toggle };
})();


// ─── Mobile Menu ─────────────────────────────────────────────────────
const MobileMenu = (() => {
  function init() {
    const btn = document.getElementById('mobile-menu-btn');
    const menu = document.getElementById('mobile-menu');
    if (!btn || !menu) return;

    btn.addEventListener('click', () => {
      const isOpen = !menu.classList.contains('hidden');
      menu.classList.toggle('hidden', isOpen);
      btn.setAttribute('aria-expanded', String(!isOpen));
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.topnav')) {
        menu.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  return { init };
})();


// ─── UI ──────────────────────────────────────────────────────────────
const UI = (() => {
  // DOM refs
  const $searchInput      = document.getElementById('search-input');
  const $searchForm       = document.getElementById('search-form');
  const $resultsContainer = document.getElementById('results-container');
  const $resultsCount     = document.getElementById('results-count');
  const $statusMessage    = document.getElementById('status-message');
  const $offlineBadge     = document.getElementById('offline-badge');
  const $recentSection    = document.getElementById('recent-section');
  const $recentList       = document.getElementById('recent-list');
  const $langBtns         = document.querySelectorAll('.lang-btn');
  const $langLabel        = document.getElementById('lang-label');
  const $suggestList      = document.getElementById('suggestions-list');
  const $alphabetBar      = document.getElementById('alphabet-bar');
  const $browseResults    = document.getElementById('browse-results');
  const $alphabetSection  = document.getElementById('alphabet-browser');

  let _currentLang    = 'en';
  let _debounceTimer  = null;
  let _suggestTimer   = null;
  let _lastQuery      = '';
  let _suggestIdx     = -1;

  // ── Helpers ──

  function _escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

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
    $resultsContainer.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;
  }

  // ── URL Routing ──

  function _pushState(query, lang) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (lang && lang !== 'en') params.set('lang', lang);
    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    history.pushState({ q: query, lang }, '', url);
  }

  function _readURL() {
    const params = new URLSearchParams(window.location.search);
    return {
      q:    params.get('q') || '',
      lang: params.get('lang') || 'en',
    };
  }

  // ── Autocomplete ──

  function _showSuggestions(items) {
    if (!items.length) { _hideSuggestions(); return; }
    _suggestIdx = -1;
    $suggestList.innerHTML = items.map((word, i) =>
      `<li role="option" class="suggestion-item" data-index="${i}" data-word="${_escapeHtml(word)}">${_escapeHtml(word)}</li>`
    ).join('');
    $suggestList.classList.remove('hidden');
  }

  function _hideSuggestions() {
    $suggestList.classList.add('hidden');
    $suggestList.innerHTML = '';
    _suggestIdx = -1;
  }

  function _navigateSuggestions(direction) {
    const items = $suggestList.querySelectorAll('.suggestion-item');
    if (!items.length) return;
    items.forEach(el => el.classList.remove('active'));
    _suggestIdx += direction;
    if (_suggestIdx < 0) _suggestIdx = items.length - 1;
    if (_suggestIdx >= items.length) _suggestIdx = 0;
    items[_suggestIdx].classList.add('active');
    $searchInput.value = items[_suggestIdx].dataset.word;
  }

  // ── Share URL ──

  function _shareURL(word, lang) {
    const base = window.location.origin + window.location.pathname;
    return `${base}?q=${encodeURIComponent(word)}&lang=${lang}`;
  }

  function _copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      _setStatus('Link copied to clipboard!', 'info');
      setTimeout(_clearStatus, 2000);
    }).catch(() => {
      prompt('Copy this link:', text);
    });
  }

  // ── Rendering ──

  function _renderEmpty(query) {
    $resultsCount.classList.add('hidden');
    $resultsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">\uD83D\uDD0D</div>
        <div class="empty-state-text">No results for \u201c${_escapeHtml(query)}\u201d</div>
        <div class="empty-state-hint">Check your spelling or try searching in the other direction.</div>
      </div>
    `;
  }

  function _renderWelcome() {
    $resultsCount.classList.add('hidden');
    $resultsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">\uD83D\uDCD6</div>
        <div class="empty-state-text">Start searching</div>
        <div class="empty-state-hint">Type an English or Mara word above to find its translation.</div>
      </div>
    `;
  }

  /**
   * Render search results — groups entries by source word so multiple POS
   * for the same word appear together (like MyOrdbok).
   */
  function _renderResults(results, lang, fromCache) {
    if (!results.length) return;

    const isEnToMara = lang === 'en';
    const countText = results.length === 1 ? '1 result' : `${results.length} results`;
    $resultsCount.textContent = countText;
    $resultsCount.classList.remove('hidden');

    // Group by source word
    const groups = new Map();
    results.forEach((entry) => {
      const sourceWord = isEnToMara ? entry.english_word : entry.mara_word;
      const key = sourceWord.toLowerCase();
      if (!groups.has(key)) groups.set(key, { word: sourceWord, entries: [] });
      groups.get(key).entries.push(entry);
    });

    let html = '';
    for (const [, group] of groups) {
      const shareUrl = _shareURL(group.word, lang);
      html += `<div class="dict-entry dict-entry-clickable">`;
      html += `<div class="dict-entry-header">`;
      html += `  <button class="dict-word dict-word-link" data-word="${_escapeHtml(group.word)}">${_escapeHtml(group.word)}</button>`;
      html += `  <button class="share-btn" data-url="${_escapeHtml(shareUrl)}" title="Copy link to this word" aria-label="Share">`;
      html += `    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
      html += `  </button>`;
      html += `</div>`;

      group.entries.forEach((entry) => {
        const targetWord  = isEnToMara ? entry.mara_word : entry.english_word;
        const targetLabel = isEnToMara ? 'Mara' : 'English';

        if (entry.part_of_speech) {
          html += `<span class="dict-pos">${_escapeHtml(entry.part_of_speech)}</span>`;
        }

        html += `<div class="dict-translation-block">`;
        html += `  <div class="dict-translation-label">${targetLabel}</div>`;
        html += `  <div class="dict-translation">${_escapeHtml(targetWord)}</div>`;
        html += `</div>`;

        if (entry.definition) {
          html += `<div class="dict-definition">${_escapeHtml(entry.definition)}</div>`;
        }
        if (entry.example_sentence) {
          html += `<div class="dict-example">\u201c${_escapeHtml(entry.example_sentence)}\u201d</div>`;
        }
      });

      html += `</div>`;
    }

    $resultsContainer.innerHTML = html;

    // Wire share buttons
    $resultsContainer.querySelectorAll('.share-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); _copyToClipboard(btn.dataset.url); });
    });

    // Wire word-heading clicks → open detail view
    $resultsContainer.querySelectorAll('.dict-word-link').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        $searchInput.value = btn.dataset.word;
        _lastQuery = '';
        _executeSearch(btn.dataset.word, true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    // Wire entire card click → open detail view
    $resultsContainer.querySelectorAll('.dict-entry-clickable').forEach(card => {
      card.addEventListener('click', () => {
        const word = card.querySelector('.dict-word-link')?.dataset?.word;
        if (word) {
          $searchInput.value = word;
          _lastQuery = '';
          _executeSearch(word, true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    });

    if (fromCache) {
      _setStatus('Showing cached results \u2014 you appear to be offline.', 'cache-notice');
    } else {
      _clearStatus();
      $resultsCount.classList.remove('hidden');
    }
  }

  /**
   * Render a full word-detail view (definition page) with related words.
   * Like MyOrdbok: word heading, POS sections, translations, examples,
   * related words, contribute prompt.
   */
  function _renderWordDetail(data, lang) {
    if (!data || !data.results || !data.results.length) {
      _renderEmpty(data?.query || '');
      return;
    }

    const isEnToMara = lang === 'en';
    const results = data.results;
    const sourceWord = isEnToMara ? results[0].english_word : results[0].mara_word;

    $resultsCount.textContent = `Definition of \u201c${sourceWord}\u201d`;
    $resultsCount.classList.remove('hidden');

    const shareUrl = _shareURL(sourceWord, lang);
    let html = `<div class="dict-entry dict-entry-detail">`;

    // Back button
    html += `<button class="detail-back-btn" id="detail-back">\u2190 Back to results</button>`;

    html += `<div class="dict-entry-header">`;
    html += `  <div class="dict-word dict-word-lg">${_escapeHtml(sourceWord)}</div>`;
    html += `  <button class="share-btn" data-url="${_escapeHtml(shareUrl)}" title="Copy link" aria-label="Share">`;
    html += `    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
    html += `  </button>`;
    html += `</div>`;

    // Group by POS — like MyOrdbok's noun/verb/phrase sections
    const posSections = new Map();
    results.forEach(entry => {
      const pos = entry.part_of_speech || 'other';
      if (!posSections.has(pos)) posSections.set(pos, []);
      posSections.get(pos).push(entry);
    });

    for (const [pos, entries] of posSections) {
      html += `<div class="dict-pos-section">`;
      html += `  <h2 class="dict-pos-heading">${_escapeHtml(pos)}</h2>`;

      entries.forEach((entry) => {
        const targetWord  = isEnToMara ? entry.mara_word : entry.english_word;
        const targetLabel = isEnToMara ? 'Mara' : 'English';

        html += `<div class="dict-translation-block">`;
        html += `  <div class="dict-translation-label">${targetLabel}</div>`;
        html += `  <div class="dict-translation">${_escapeHtml(targetWord)}</div>`;
        html += `</div>`;

        if (entry.definition) {
          html += `<div class="dict-definition">${_escapeHtml(entry.definition)}</div>`;
        }
        if (entry.example_sentence) {
          html += `<div class="dict-example">\u201c${_escapeHtml(entry.example_sentence)}\u201d</div>`;
        }
      });

      html += `</div>`;
    }

    // Thesaurus / Related words section — grouped by POS like MyOrdbok
    if (data.related && data.related.length) {
      html += `<div class="dict-related">`;
      html += `  <h3 class="dict-related-title">Thesaurus</h3>`;
      html += `  <p class="dict-related-count">\u2014 ${data.related.length} word${data.related.length !== 1 ? 's' : ''} related to <em>${_escapeHtml(sourceWord)}</em></p>`;
      html += `  <div class="dict-related-list">`;
      data.related.forEach(w => {
        html += `<button class="dict-related-word" data-word="${_escapeHtml(w)}">${_escapeHtml(w)}</button>`;
      });
      html += `  </div>`;
      html += `</div>`;
    }

    // Contribute prompt — "Help us shape the term" like MyOrdbok
    html += `<div class="dict-contribute">`;
    html += `  <h4 class="dict-contribute-title">Help us shape the term of \u201c${_escapeHtml(sourceWord)}\u201d</h4>`;
    html += `  <p class="dict-contribute-text">The contribution always plays a crucial role in shaping the excellence of <strong>${_escapeHtml(sourceWord)}</strong>. By sharing your insights on it context using Google Forms such as,</p>`;
    html += `  <ul class="dict-contribute-list">`;
    html += `    <li>\u2026definition: meaning, translation</li>`;
    html += `    <li>\u2026grammar: spelling, punctuation</li>`;
    html += `    <li>\u2026example: when, where and how to use its</li>`;
    html += `  </ul>`;
    html += `  <p class="dict-contribute-text">\u2026its actively help us refine meaningful content and elevate the user experience.</p>`;
    html += `  <p class="dict-contribute-text">We want you to know that your efforts are immensely appreciated and instrumental in making the dictionary even better.</p>`;
    html += `  <div class="dict-contribute-actions">`;
    html += `    <a href="https://docs.google.com/forms/d/e/1FAIpQLSceWwVrtH5KivCR3wuvKqMn8U238-aCxOJIIWs1gK4pt994oA/viewform" target="_blank" rel="noopener" class="contribute-link contribute-link-primary">\u270F\uFE0F Suggest improvement</a>`;
    html += `    <a href="https://docs.google.com/forms/d/e/1FAIpQLSceWwVrtH5KivCR3wuvKqMn8U238-aCxOJIIWs1gK4pt994oA/viewform" target="_blank" rel="noopener" class="contribute-link">Your feedback on overall experiences is also highly welcome</a>`;
    html += `  </div>`;
    html += `</div>`;

    html += `</div>`;

    $resultsContainer.innerHTML = html;

    // Wire share buttons
    $resultsContainer.querySelectorAll('.share-btn').forEach(btn => {
      btn.addEventListener('click', () => _copyToClipboard(btn.dataset.url));
    });

    // Wire related word clicks
    $resultsContainer.querySelectorAll('.dict-related-word').forEach(btn => {
      btn.addEventListener('click', () => {
        $searchInput.value = btn.dataset.word;
        _lastQuery = '';
        _executeSearch(btn.dataset.word, true);
      });
    });

    // Wire back button
    const backBtn = document.getElementById('detail-back');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        history.back();
      });
    }

    _clearStatus();
    $resultsCount.classList.remove('hidden');
  }

  // ── Alphabet Browse ──

  function _buildAlphabetBar() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    $alphabetBar.innerHTML = letters.map(l =>
      `<button class="alpha-btn" data-letter="${l}">${l}</button>`
    ).join('');
  }

  async function _browseLetter(letter, page = 1) {
    // Highlight active letter
    $alphabetBar.querySelectorAll('.alpha-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.letter === letter);
    });

    $browseResults.classList.remove('hidden');
    $browseResults.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;

    const data = await API.browse(letter.toLowerCase(), _currentLang, page);
    if (!data || !data.words || !data.words.length) {
      $browseResults.innerHTML = `<p class="browse-empty">No words starting with \u201c${letter}\u201d.</p>`;
      return;
    }

    let html = `<div class="browse-header">`;
    html += `  <span class="browse-label">Words starting with <strong>${letter}</strong></span>`;
    html += `  <span class="browse-count">${data.total} word${data.total !== 1 ? 's' : ''}</span>`;
    html += `</div>`;
    html += `<div class="browse-word-grid">`;
    data.words.forEach(w => {
      html += `<button class="browse-word" data-word="${_escapeHtml(w.word)}">`;
      html += `  <span class="browse-word-text">${_escapeHtml(w.word)}</span>`;
      if (w.part_of_speech) html += `<span class="browse-word-pos">${_escapeHtml(w.part_of_speech)}</span>`;
      html += `</button>`;
    });
    html += `</div>`;

    // Pagination
    if (data.totalPages > 1) {
      html += `<div class="browse-pagination">`;
      if (page > 1) {
        html += `<button class="browse-page-btn" data-letter="${letter}" data-page="${page - 1}">\u2190 Previous</button>`;
      }
      html += `<span class="browse-page-info">Page ${page} of ${data.totalPages}</span>`;
      if (page < data.totalPages) {
        html += `<button class="browse-page-btn" data-letter="${letter}" data-page="${page + 1}">Next \u2192</button>`;
      }
      html += `</div>`;
    }

    $browseResults.innerHTML = html;

    // Wire word clicks
    $browseResults.querySelectorAll('.browse-word').forEach(btn => {
      btn.addEventListener('click', () => {
        $searchInput.value = btn.dataset.word;
        _lastQuery = '';
        _executeSearch(btn.dataset.word, true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    // Wire pagination
    $browseResults.querySelectorAll('.browse-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _browseLetter(btn.dataset.letter, parseInt(btn.dataset.page, 10));
      });
    });
  }

  // ── Recent ──

  function _renderRecent() {
    const recent = RecentSearches.getAll();
    if (!recent.length) {
      $recentSection.classList.add('hidden');
      return;
    }
    $recentSection.classList.remove('hidden');
    $recentList.innerHTML = recent.map((item) => `
      <li>
        <button class="recent-item" data-query="${_escapeHtml(item.q)}" data-lang="${item.lang}">
          <span class="recent-item-lang">${item.lang === 'en' ? 'EN' : 'MRH'}</span>
          ${_escapeHtml(item.q)}
        </button>
      </li>
    `).join('');
  }

  // ── Offline ──

  function _updateOfflineBadge(online) {
    if (online) {
      $offlineBadge.classList.add('hidden');
    } else {
      $offlineBadge.classList.remove('hidden');
    }
  }

  // ── Search Execution ──

  async function _executeSearch(query, exactLookup = false) {
    query = query.trim();
    if (query.length < Config.MIN_QUERY_LENGTH) {
      _clearStatus();
      _renderWelcome();
      _lastQuery = '';
      _pushState('', _currentLang);
      return;
    }

    if (query === _lastQuery && !exactLookup) return;
    _lastQuery = query;

    _hideSuggestions();
    _showLoading();
    _clearStatus();
    _pushState(query, _currentLang);

    // Update page title
    document.title = `${query} \u2014 MaraDict`;

    try {
      if (exactLookup) {
        // Use the word endpoint for grouped definition view
        const data = await API.word(query, _currentLang);
        if (data && data.results && data.results.length) {
          _renderWordDetail(data, _currentLang);
          RecentSearches.add(query, _currentLang);
          _renderRecent();
          return;
        }
        // If no exact match, fall through to regular search
      }

      const { results, fromCache, offline, error } = await API.search(query, _currentLang);

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

  // ── Event Handlers ──

  function _onInput() {
    clearTimeout(_debounceTimer);
    const query = $searchInput.value;
    if (!query.trim()) {
      _clearStatus();
      _renderWelcome();
      _lastQuery = '';
      _renderRecent();
      _hideSuggestions();
      return;
    }
    // Fetch suggestions
    clearTimeout(_suggestTimer);
    _suggestTimer = setTimeout(async () => {
      const suggestions = await API.suggest(query, _currentLang);
      if ($searchInput.value.trim() === query.trim()) {
        _showSuggestions(suggestions);
      }
    }, Config.SUGGEST_DEBOUNCE);

    // Debounced search
    _debounceTimer = setTimeout(() => _executeSearch(query), Config.DEBOUNCE_MS);
  }

  function _onSubmit(e) {
    e.preventDefault();
    clearTimeout(_debounceTimer);
    _hideSuggestions();
    _lastQuery = '';
    _executeSearch($searchInput.value, true); // exact lookup on Enter
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
    if ($langLabel) {
      $langLabel.textContent = _currentLang === 'en' ? 'English \u2014 Mara' : 'Mara \u2014 English';
    }
    if ($searchInput.value.trim()) {
      _lastQuery = '';
      _executeSearch($searchInput.value);
    }
  }

  function _onRecentClick(e) {
    const btn = e.target.closest('.recent-item');
    if (!btn) return;
    const query = btn.dataset.query;
    const lang  = btn.dataset.lang;
    _currentLang = lang;
    $langBtns.forEach((b) => {
      const isActive = b.dataset.lang === lang;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', String(isActive));
    });
    if ($langLabel) {
      $langLabel.textContent = _currentLang === 'en' ? 'English \u2014 Mara' : 'Mara \u2014 English';
    }
    $searchInput.value = query;
    _lastQuery = '';
    _executeSearch(query, true);
  }

  function _onSuggestionClick(e) {
    const item = e.target.closest('.suggestion-item');
    if (!item) return;
    $searchInput.value = item.dataset.word;
    _hideSuggestions();
    _lastQuery = '';
    _executeSearch(item.dataset.word, true);
  }

  function _onKeyDown(e) {
    if (!$suggestList.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); _navigateSuggestions(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); _navigateSuggestions(-1); return; }
      if (e.key === 'Escape')    { _hideSuggestions(); return; }
      if (e.key === 'Enter' && _suggestIdx >= 0) {
        e.preventDefault();
        const items = $suggestList.querySelectorAll('.suggestion-item');
        if (items[_suggestIdx]) {
          $searchInput.value = items[_suggestIdx].dataset.word;
          _hideSuggestions();
          _lastQuery = '';
          _executeSearch($searchInput.value, true);
        }
        return;
      }
    }
  }

  /** Global keyboard shortcut: "/" to focus search */
  function _onGlobalKeyDown(e) {
    if (e.key === '/' && document.activeElement !== $searchInput &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      $searchInput.focus();
      $searchInput.select();
    }
  }

  function _onAlphabetClick(e) {
    const btn = e.target.closest('.alpha-btn');
    if (!btn) return;
    _browseLetter(btn.dataset.letter);
  }

  function _onNetworkChange(online) {
    _updateOfflineBadge(online);
    if (online && _lastQuery) _executeSearch(_lastQuery);
  }

  /** Handle browser back/forward */
  function _onPopState() {
    const { q, lang } = _readURL();
    if (lang && lang !== _currentLang) {
      _currentLang = lang;
      $langBtns.forEach((b) => {
        const isActive = b.dataset.lang === lang;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', String(isActive));
      });
      if ($langLabel) {
        $langLabel.textContent = _currentLang === 'en' ? 'English \u2014 Mara' : 'Mara \u2014 English';
      }
    }
    if (q) {
      $searchInput.value = q;
      _lastQuery = '';
      _executeSearch(q, true);
    } else {
      $searchInput.value = '';
      _lastQuery = '';
      _clearStatus();
      _renderWelcome();
      _renderRecent();
      document.title = 'English \u21C4 Mara Dictionary';
    }
  }

  // Close suggestions on outside click
  function _onDocClick(e) {
    if (!e.target.closest('.search-bar-wrap')) {
      _hideSuggestions();
    }
  }

  // ── Init ──

  function init() {
    _buildAlphabetBar();

    $searchInput.addEventListener('input', _onInput);
    $searchInput.addEventListener('keydown', _onKeyDown);
    $searchForm.addEventListener('submit', _onSubmit);
    $langBtns.forEach((btn) => btn.addEventListener('click', _onLangSwitch));
    $recentList.addEventListener('click', _onRecentClick);
    $suggestList.addEventListener('click', _onSuggestionClick);
    $alphabetBar.addEventListener('click', _onAlphabetClick);
    document.addEventListener('keydown', _onGlobalKeyDown);
    document.addEventListener('click', _onDocClick);
    window.addEventListener('popstate', _onPopState);

    Network.onChange(_onNetworkChange);
    _updateOfflineBadge(Network.isOnline());

    // Check URL for initial query (shareable links / bookmarks)
    const { q, lang } = _readURL();
    if (lang && lang !== 'en') {
      _currentLang = lang;
      $langBtns.forEach((b) => {
        const isActive = b.dataset.lang === lang;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', String(isActive));
      });
      if ($langLabel) {
        $langLabel.textContent = _currentLang === 'en' ? 'English \u2014 Mara' : 'Mara \u2014 English';
      }
    }
    if (q) {
      $searchInput.value = q;
      _executeSearch(q, true);
    } else {
      _renderWelcome();
    }

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
      console.warn('IndexedDB unavailable \u2014 cache disabled.');
    }

    Network.init();
    ThemeToggle.init();
    MobileMenu.init();
    UI.init();
    CookieConsent.init();
  }

  return { init };
})();

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
