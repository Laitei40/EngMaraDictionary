/**
 * English ⇄ Mara Dictionary — Cloudflare Worker API
 * Editorial Workflow Edition
 *
 * Public Endpoints:
 *   GET /api/search?q=<query>&lang=en|mrh
 *   GET /api/suggest?q=<prefix>&lang=en|mrh
 *   GET /api/word?q=<word>&lang=en|mrh
 *   GET /api/browse?letter=<A-Z>&lang=en|mrh&page=1
 *   GET /api/stats
 *   GET /api/health
 *   GET /api/public-config
 *   GET /api/updates?since=<ISO8601>
 *   POST /api/suggestions
 *
 * Admin Endpoints (Cloudflare Access + Role Authorization):
 *   GET    /api/admin/entries?page=1&q=<filter>
 *   POST   /api/admin/entries
 *   PUT    /api/admin/entries/:id
 *   POST   /api/admin/entries/:id/archive
 *   POST   /api/admin/entries/:id/restore
 *   GET    /api/admin/entries/:id/meanings
 *   GET    /api/admin/revisions?status=pending
 *   GET    /api/admin/revisions/:id
 *   POST   /api/admin/revisions/:id/approve
 *   POST   /api/admin/revisions/:id/reject
 *   GET    /api/admin/suggestions
 *   PATCH  /api/admin/suggestions/:id
 *   DELETE /api/admin/suggestions/:id
 *   GET    /api/admin/users
 *   POST   /api/admin/users
 *   PUT    /api/admin/users/:id
 *   DELETE /api/admin/users/:id
 *   GET    /api/admin/audit-logs
 *   GET    /api/admin/me
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    const adminCorsHeaders = {
      'Access-Control-Allow-Origin': 'https://admindic.marareih.org',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-Authenticated-User-Email',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      const h = url.pathname.startsWith('/api/admin/') ? adminCorsHeaders : corsHeaders;
      return new Response(null, { status: 204, headers: h });
    }

    if (url.pathname.startsWith('/api/admin/')) {
      try {
        return await handleAdmin(request, url, env, ctx, adminCorsHeaders);
      } catch (err) {
        console.error('Top-level admin error:', err.message, err.stack);
        return new Response(JSON.stringify({ error: 'Internal server error', details: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...adminCorsHeaders },
        });
      }
    }

    if (url.pathname === '/api/suggestions') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
      }
      return await handleSuggestionSubmit(request, env, corsHeaders);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    try {
      if (url.pathname === '/api/search')        return await handleSearch(url, env.DB, corsHeaders);
      if (url.pathname === '/api/suggest')        return await handleSuggest(url, env.DB, corsHeaders);
      if (url.pathname === '/api/word')           return await handleWord(url, env.DB, corsHeaders);
      if (url.pathname === '/api/browse')         return await handleBrowse(url, env.DB, corsHeaders);
      if (url.pathname === '/api/stats')          return await handleStats(env.DB, corsHeaders);
      if (url.pathname === '/api/updates')        return await handleUpdates(url, env.DB, corsHeaders);
      if (url.pathname === '/api/health')
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() }, 200, corsHeaders);
      if (url.pathname === '/api/public-config')
        return jsonResponse({ turnstile_site_key: env.TURNSTILE_SITE_KEY || '' }, 200, { ...corsHeaders, 'Cache-Control': 'public, max-age=300' });

      if (url.pathname === '/' || url.pathname === '') {
        return new Response(`<!DOCTYPE html><html><head><title>Mara Dictionary API</title></head><body>
          <h1>Mara Dictionary API</h1><p>Endpoints:</p><ul>
          <li><a href="/api/health">/api/health</a></li>
          <li><a href="/api/search?q=water&lang=en">/api/search?q=water&lang=en</a></li>
          <li><a href="/api/search?q=ti&lang=mrh">/api/search?q=ti&lang=mrh</a></li>
          </ul></body></html>`, { status: 200, headers: { 'Content-Type': 'text/html', ...corsHeaders } });
      }

      return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal server error', details: err.message }, 500, corsHeaders);
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// AUTHORIZATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

async function authenticateAdmin(request, db) {
  const email = (
    request.headers.get('CF-Access-Authenticated-User-Email') || ''
  ).trim().toLowerCase();

  if (!email) {
    return { error: 'Authentication required. No CF-Access identity found.', status: 401 };
  }

  const user = await db.prepare(
    'SELECT id, email, role, is_active FROM admin_users WHERE LOWER(email) = ?1'
  ).bind(email).first();

  if (!user) {
    return { error: `Access denied. Email "${email}" is not registered as an admin.`, status: 403 };
  }
  if (!user.is_active) {
    return { error: 'Account is deactivated. Contact a super admin.', status: 403 };
  }

  return { email: user.email, role: user.role, userId: user.id };
}

const ROLE_HIERARCHY = { super_admin: 3, senior_reviewer: 2, reviewer: 1 };

function hasRole(userRole, requiredRole) {
  return (ROLE_HIERARCHY[userRole] || 0) >= (ROLE_HIERARCHY[requiredRole] || 999);
}

// ═══════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════

async function insertAuditLog(db, { action, table_name, record_id, performed_by, old_value, new_value }) {
  await db.prepare(`
    INSERT INTO audit_logs (action, table_name, record_id, performed_by, old_value, new_value)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).bind(
    action,
    table_name,
    record_id || null,
    performed_by,
    old_value ? JSON.stringify(old_value) : null,
    new_value ? JSON.stringify(new_value) : null,
  ).run();
}

// ═══════════════════════════════════════════════════════════════
// GITHUB INTEGRATION — Glottolog-style (GitHub ↔ D1 canonical sync)
//
// Flow: every write op → D1 updated immediately + ctx.waitUntil(syncToGitHub)
//       "Publish Live" → fetch dictionary-data.json from GitHub → atomic D1 replace
//
// Secrets (set via: npx wrangler secret put <NAME>):
//   GITHUB_TOKEN         — PAT with repo:write scope
// Optional env vars (Cloudflare dashboard → Variables):
//   GITHUB_OWNER         — default: MLP
//   GITHUB_REPO          — default: mara-dictionary-archive
//   GITHUB_BRANCH        — default: main
//   GITHUB_SQL_PATH      — default: worker/seed_updated.sql
//   GITHUB_JSON_PATH     — default: worker/dictionary-data.json
// ═══════════════════════════════════════════════════════════════

function ghConfig(env) {
  return {
    owner:    env.GITHUB_OWNER    || 'Laitei40',
    repo:     env.GITHUB_REPO     || 'EngMaraDictionary',
    branch:   env.GITHUB_BRANCH   || 'main',
    sqlPath:  env.GITHUB_SQL_PATH  || 'worker/seed_updated.sql',
    jsonPath: env.GITHUB_JSON_PATH || 'worker/dictionary-data.json',
  };
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Mara-Dictionary-Worker/2.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// ── Export: D1 → SQL (human-readable, committed to sqlPath) ──
async function exportDictionaryAsSQL(db) {
  const { results } = await db.prepare(`
    SELECT id, english_word, mara_word, part_of_speech, definition, example_sentence
    FROM dictionary
    WHERE status != 'archived'
    ORDER BY english_word ASC
  `).all();
  const esc = v => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
  const header = [
    '-- ============================================================',
    '-- English ⇄ Mara Dictionary — Seed Data (Auto-exported)',
    `-- Generated: ${new Date().toISOString()}`,
    `-- Total entries: ${results.length}`,
    '-- ============================================================',
    '',
    'DELETE FROM dictionary;',
    "DELETE FROM sqlite_sequence WHERE name='dictionary';",
    '',
  ].join('\n');
  if (!results.length) return header + '-- (no entries)\n';
  const rows = results.map(r =>
    `  (${esc(r.english_word)}, ${esc(r.mara_word)}, ` +
    `${esc(r.part_of_speech)}, ${esc(r.definition)}, ${esc(r.example_sentence)})`
  ).join(',\n');
  return header +
    'INSERT INTO dictionary (english_word, mara_word, part_of_speech, definition, example_sentence) VALUES\n' +
    rows + ';\n';
}

// ── Export: D1 → JSON (machine-readable, committed to jsonPath) ──
async function exportDictionaryAsJSON(db) {
  const { results } = await db.prepare(`
    SELECT id, english_word, mara_word, part_of_speech, definition, example_sentence,
           version, status, approved_by, approved_at, updated_by, updated_at, created_at
    FROM dictionary
    WHERE status != 'archived'
    ORDER BY english_word ASC
  `).all();
  // Compact (no whitespace) to minimise payload size and CPU encoding time
  return JSON.stringify({
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    total: results.length,
    entries: results,
  });
}

// ── Low-level GitHub API helpers ───────────────────────────────
// Encode each path segment but preserve slashes
function ghEncodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

function utf8ToBase64(str) {
  // Safe base64 encoding for Cloudflare Workers (no unescape/escape)
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ── Git Data API helpers (no 1 MB file size limit) ────────────

async function ghApiPost(token, url, body) {
  const { signal, clear } = withTimeout(60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: ghHeaders(token),
      body: JSON.stringify(body),
      signal,
    });
    clear();
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text };
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    clear();
    return { ok: false, error: e.message };
  }
}

async function ghApiGet(token, url) {
  const { signal, clear } = withTimeout(15000);
  try {
    const res = await fetch(url, { headers: ghHeaders(token), signal });
    clear();
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (e) {
    clear();
    return { ok: false, error: e.message };
  }
}

async function ghApiPatch(token, url, body) {
  const { signal, clear } = withTimeout(15000);
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: ghHeaders(token),
      body: JSON.stringify(body),
      signal,
    });
    clear();
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text };
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    clear();
    return { ok: false, error: e.message };
  }
}

// Commit multiple files in one GitHub commit using the Git Data API.
// Handles files of any size (no 1 MB Contents API limit).
async function ghCommitFiles(token, owner, repo, branch, files, message) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  // 1. Get current HEAD ref
  const refRes = await ghApiGet(token, `${base}/git/ref/heads/${branch}`);
  if (!refRes.ok) return { success: false, step: 'get_ref', error: refRes.error || refRes.status };
  const headSha = refRes.data.object.sha;

  // 2. Get tree SHA of current HEAD commit
  const commitRes = await ghApiGet(token, `${base}/git/commits/${headSha}`);
  if (!commitRes.ok) return { success: false, step: 'get_commit', error: commitRes.error || commitRes.status };
  const baseTreeSha = commitRes.data.tree.sha;

  // 3. Create blobs for each file
  const treeItems = [];
  for (const { path, content } of files) {
    console.log(`[ghCommitFiles] creating blob for ${path} (${content.length} bytes)`);
    const blobRes = await ghApiPost(token, `${base}/git/blobs`, {
      content: content,
      encoding: 'utf-8',
    });
    if (!blobRes.ok) return { success: false, step: `blob:${path}`, error: blobRes.error || blobRes.status };
    treeItems.push({ path, mode: '100644', type: 'blob', sha: blobRes.data.sha });
  }

  // 4. Create new tree
  const treeRes = await ghApiPost(token, `${base}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeItems,
  });
  if (!treeRes.ok) return { success: false, step: 'create_tree', error: treeRes.error || treeRes.status };

  // 5. Create new commit
  const newCommitRes = await ghApiPost(token, `${base}/git/commits`, {
    message,
    tree: treeRes.data.sha,
    parents: [headSha],
  });
  if (!newCommitRes.ok) return { success: false, step: 'create_commit', error: newCommitRes.error || newCommitRes.status };
  const newCommitSha = newCommitRes.data.sha;

  // 6. Advance branch ref
  const updateRes = await ghApiPatch(token, `${base}/git/refs/heads/${branch}`, {
    sha: newCommitSha,
    force: false,
  });
  if (!updateRes.ok) return { success: false, step: 'update_ref', error: updateRes.error || updateRes.status };

  return { success: true, commit_sha: newCommitSha };
}

async function ghGetLastCommit(token, owner, repo, path, branch) {
  const { signal, clear } = withTimeout(5000);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1&sha=${branch}`,
      { headers: ghHeaders(token), signal }
    );
    clear();
    if (!res.ok) return null;
    const commits = await res.json();
    if (!Array.isArray(commits) || !commits.length) return null;
    const c = commits[0];
    return {
      sha:       c.sha,
      short_sha: c.sha.slice(0, 7),
      message:   c.commit.message.split('\n')[0],
      author:    c.commit.author.name,
      date:      c.commit.author.date,
      url:       c.html_url,
    };
  } catch { clear(); return null; }
}

async function ghFetchFileContent(token, owner, repo, path, branch) {
  const { signal, clear } = withTimeout(12000);
  let res;
  try {
    res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${ghEncodePath(path)}?ref=${branch}`,
      { headers: ghHeaders(token), signal }
    );
    clear();
  } catch (e) {
    clear();
    throw new Error(e.name === 'AbortError' ? `GitHub fetch timed out: ${path}` : e.message);
  }
  if (!res.ok) throw new Error(`GitHub fetch failed (${res.status}): ${path}`);
  const d = await res.json();
  const bytes = Uint8Array.from(atob(d.content.replace(/\n/g, '')), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ── Main sync: D1 → GitHub ─────────────────────────────────────
async function syncToGitHub(env, db, commitMessage) {
  const cfg = ghConfig(env);
  const token = env.GITHUB_TOKEN;
  if (!token) return { skipped: true, reason: 'GITHUB_TOKEN not configured' };
  try {
    console.log('[syncToGitHub] exporting JSON from D1...');
    const jsonContent = await exportDictionaryAsJSON(db);
    console.log(`[syncToGitHub] JSON ${jsonContent.length} bytes`);

    const result = await ghCommitFiles(token, cfg.owner, cfg.repo, cfg.branch, [
      { path: cfg.jsonPath, content: jsonContent },
    ], commitMessage);

    console.log('[syncToGitHub] result:', JSON.stringify(result));
    return result;
  } catch (err) {
    console.error('syncToGitHub error:', err.message);
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC HANDLERS (all filter status = 'approved')
// ═══════════════════════════════════════════════════════════════

async function handleSearch(url, db, corsHeaders) {
  const query  = (url.searchParams.get('q') || '').trim();
  const lang   = (url.searchParams.get('lang') || 'en').toLowerCase();
  const limit  = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

  if (!query)             return jsonResponse({ error: 'Missing search query. Use ?q=word' }, 400, corsHeaders);
  if (query.length > 100) return jsonResponse({ error: 'Query too long (max 100 characters)' }, 400, corsHeaders);
  if (lang !== 'en' && lang !== 'mrh')
    return jsonResponse({ error: 'Invalid lang parameter. Use "en" or "mrh".' }, 400, corsHeaders);

  const ftsCol   = lang === 'en' ? 'english_word' : 'mara_word';
  const orderCol = lang === 'en' ? 'english_word' : 'mara_word';

  const terms = query.replace(/["^*()[\]{}:!]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return jsonResponse({ query, lang, count: 0, results: [] }, 200, corsHeaders);
  const ftsQuery = terms.map(t => `${ftsCol}:${t}*`).join(' ');

  try {
    const { results } = await db.prepare(`
      SELECT d.id, d.english_word, d.mara_word, d.part_of_speech, d.definition, d.example_sentence
      FROM dictionary d
      WHERE d.id IN (SELECT rowid FROM dictionary_fts WHERE dictionary_fts MATCH ?1)
        AND d.status = 'approved'
      ORDER BY d.${orderCol} ASC
      LIMIT ?2 OFFSET ?3
    `).bind(ftsQuery, limit, offset).all();

    return jsonResponse(
      { query, lang, count: results.length, results },
      200,
      { ...corsHeaders, 'Cache-Control': 'public, max-age=300' }
    );
  } catch (ftsErr) {
    console.error('FTS search error — falling back to LIKE:', ftsErr.message);
    const col     = lang === 'en' ? 'english_word' : 'mara_word';
    const pattern = `${query}%`;
    try {
      const { results } = await db.prepare(`
        SELECT id, english_word, mara_word, part_of_speech, definition, example_sentence
        FROM dictionary
        WHERE ${col} LIKE ?1 COLLATE NOCASE
          AND status = 'approved'
        ORDER BY ${col} ASC
        LIMIT ?2 OFFSET ?3
      `).bind(pattern, limit, offset).all();
      return jsonResponse({ query, lang, count: results.length, results }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }
}

async function handleSuggest(url, db, corsHeaders) {
  const query = (url.searchParams.get('q') || '').trim();
  const lang  = (url.searchParams.get('lang') || 'en').toLowerCase();

  if (!query) return jsonResponse({ suggestions: [] }, 200, corsHeaders);
  if (lang !== 'en' && lang !== 'mrh') return jsonResponse({ suggestions: [] }, 200, corsHeaders);

  const col = lang === 'en' ? 'english_word' : 'mara_word';

  try {
    const { results } = await db.prepare(`
      SELECT DISTINCT ${col} AS word
      FROM dictionary
      WHERE ${col} LIKE ?1 COLLATE NOCASE
        AND status = 'approved'
      ORDER BY LENGTH(${col}) ASC, ${col} ASC
      LIMIT 8
    `).bind(`${query}%`).all();

    return jsonResponse(
      { suggestions: results.map(r => r.word) },
      200,
      { ...corsHeaders, 'Cache-Control': 'public, max-age=60' }
    );
  } catch (err) {
    return jsonResponse({ suggestions: [], error: err.message }, 200, corsHeaders);
  }
}

async function handleWord(url, db, corsHeaders) {
  const query = (url.searchParams.get('q') || '').trim();
  const lang  = (url.searchParams.get('lang') || 'en').toLowerCase();

  if (!query) return jsonResponse({ error: 'Missing word query' }, 400, corsHeaders);
  if (lang !== 'en' && lang !== 'mrh') return jsonResponse({ error: 'Invalid lang' }, 400, corsHeaders);

  const col = lang === 'en' ? 'english_word' : 'mara_word';
  const lowerQ = query.toLowerCase();

  try {
    const { results } = await db.prepare(`
      SELECT id, english_word, mara_word, part_of_speech, definition, example_sentence
      FROM dictionary
      WHERE LOWER(${col}) = ?1
        AND status = 'approved'
      ORDER BY
        CASE part_of_speech
          WHEN 'noun' THEN 0 WHEN 'verb' THEN 1 WHEN 'adjective' THEN 2
          WHEN 'adverb' THEN 3 WHEN 'phrase' THEN 4 WHEN 'interjection' THEN 5
          WHEN 'number' THEN 6 WHEN 'particle' THEN 7 ELSE 8
        END
    `).bind(lowerQ).all();

    if (results.length) {
      const ids = results.map(r => r.id);
      const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
      const { results: meanings } = await db.prepare(`
        SELECT id, dictionary_id, part_of_speech, definition, examples, synonyms, antonyms, "order"
        FROM meanings
        WHERE dictionary_id IN (${placeholders})
        ORDER BY dictionary_id, "order" ASC, id ASC
      `).bind(...ids).all();

      const meaningsMap = new Map();
      meanings.forEach(m => {
        if (!meaningsMap.has(m.dictionary_id)) meaningsMap.set(m.dictionary_id, []);
        let exampleArr = [];
        if (m.examples) { try { exampleArr = JSON.parse(m.examples); } catch { exampleArr = [m.examples]; } }
        let synArr = [];
        if (m.synonyms) { try { synArr = JSON.parse(m.synonyms); } catch { synArr = [m.synonyms]; } }
        let antArr = [];
        if (m.antonyms) { try { antArr = JSON.parse(m.antonyms); } catch { antArr = [m.antonyms]; } }
        meaningsMap.get(m.dictionary_id).push({
          part_of_speech: m.part_of_speech, definition: m.definition,
          examples: exampleArr, synonyms: synArr, antonyms: antArr,
        });
      });
      results.forEach(r => { r.meanings = meaningsMap.get(r.id) || []; });
    }

    const prefix = lowerQ.length >= 3 ? lowerQ.substring(0, 3) : lowerQ;
    const { results: related } = await db.prepare(`
      SELECT DISTINCT ${col} AS word
      FROM dictionary
      WHERE LOWER(${col}) LIKE ?1
        AND LOWER(${col}) != ?2
        AND status = 'approved'
      ORDER BY ${col} ASC
      LIMIT 10
    `).bind(`${prefix}%`, lowerQ).all();

    return jsonResponse(
      { query, lang, count: results.length, results, related: related.map(r => r.word) },
      200,
      { ...corsHeaders, 'Cache-Control': 'public, max-age=60' }
    );
  } catch (err) {
    return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
  }
}

async function handleBrowse(url, db, corsHeaders) {
  const letter = (url.searchParams.get('letter') || 'a').trim().toLowerCase();
  const lang   = (url.searchParams.get('lang') || 'en').toLowerCase();
  const page   = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const perPage = 30;
  const offset  = (page - 1) * perPage;

  if (lang !== 'en' && lang !== 'mrh')
    return jsonResponse({ error: 'Invalid lang' }, 400, corsHeaders);

  const col = lang === 'en' ? 'english_word' : 'mara_word';

  try {
    const countResult = await db.prepare(`
      SELECT COUNT(DISTINCT ${col}) AS total
      FROM dictionary
      WHERE LOWER(${col}) LIKE ?1
        AND status = 'approved'
    `).bind(`${letter}%`).first();
    const total = countResult?.total || 0;

    const { results } = await db.prepare(`
      SELECT DISTINCT ${col} AS word, part_of_speech
      FROM dictionary
      WHERE LOWER(${col}) LIKE ?1
        AND status = 'approved'
      ORDER BY ${col} ASC
      LIMIT ?2 OFFSET ?3
    `).bind(`${letter}%`, perPage, offset).all();

    return jsonResponse(
      { letter, lang, page, perPage, total, totalPages: Math.ceil(total / perPage), words: results },
      200,
      { ...corsHeaders, 'Cache-Control': 'public, max-age=600' }
    );
  } catch (err) {
    return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
  }
}

async function handleStats(db, corsHeaders) {
  try {
    const stats = await db.prepare(`
      SELECT
        COUNT(*) AS total_entries,
        COUNT(DISTINCT english_word) AS unique_english,
        COUNT(DISTINCT mara_word) AS unique_mara,
        COUNT(DISTINCT part_of_speech) AS pos_count,
        COUNT(CASE WHEN definition IS NOT NULL AND definition != '' THEN 1 END) AS with_definition,
        COUNT(CASE WHEN example_sentence IS NOT NULL AND example_sentence != '' THEN 1 END) AS with_example
      FROM dictionary
      WHERE status = 'approved'
    `).first();

    const { results: posBreakdown } = await db.prepare(`
      SELECT part_of_speech, COUNT(*) AS count
      FROM dictionary
      WHERE part_of_speech IS NOT NULL AND status = 'approved'
      GROUP BY part_of_speech
      ORDER BY count DESC
    `).all();

    return jsonResponse(
      { ...stats, parts_of_speech: posBreakdown, last_updated: new Date().toISOString() },
      200,
      { ...corsHeaders, 'Cache-Control': 'public, max-age=3600' }
    );
  } catch (err) {
    return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
  }
}

async function handleUpdates(url, db, corsHeaders) {
  const since  = (url.searchParams.get('since') || '').trim();
  const limit  = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

  if (!since)
    return jsonResponse({ error: 'Missing required parameter: since (ISO 8601 timestamp)' }, 400, corsHeaders);

  try {
    const { results } = await db.prepare(`
      SELECT id, english_word, mara_word, part_of_speech, definition, example_sentence, updated_at
      FROM dictionary
      WHERE updated_at > ?1
        AND status = 'approved'
      ORDER BY updated_at ASC
      LIMIT ?2 OFFSET ?3
    `).bind(since, limit, offset).all();

    return jsonResponse(
      { since, count: results.length, results, hasMore: results.length === limit },
      200,
      { ...corsHeaders, 'Cache-Control': 'no-store' }
    );
  } catch (err) {
    return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
  }
}

// ═══════════════════════════════════════════════════════════════
// SUGGESTION SUBMIT (public)
// ═══════════════════════════════════════════════════════════════

async function handleSuggestionSubmit(request, env, corsHeaders) {
  const db = env.DB;
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }

  const source_word = String(body.source_word || '').trim();
  const source_lang = String(body.source_lang || '').trim().toLowerCase();
  const english_word = String(body.english_word || '').trim() || null;
  const mara_word = String(body.mara_word || '').trim() || null;
  const suggested_definition = String(body.suggested_definition || '').trim();
  const suggested_example = String(body.suggested_example || '').trim() || null;
  const notes = String(body.notes || '').trim() || null;
  const submitter_name = String(body.submitter_name || '').trim() || null;
  const submitter_email = String(body.submitter_email || '').trim() || null;
  const turnstile_token = String(body.turnstile_token || '').trim();

  if (!source_word || !suggested_definition)
    return jsonResponse({ error: 'source_word and suggested_definition are required' }, 400, corsHeaders);
  if (!turnstile_token)
    return jsonResponse({ error: 'Missing Turnstile token' }, 400, corsHeaders);
  if (source_lang !== 'en' && source_lang !== 'mrh')
    return jsonResponse({ error: 'Invalid source_lang. Use "en" or "mrh".' }, 400, corsHeaders);
  if (source_word.length > 120 || suggested_definition.length > 5000)
    return jsonResponse({ error: 'Input too long' }, 400, corsHeaders);
  if (submitter_email && !/^\S+@\S+\.\S+$/.test(submitter_email))
    return jsonResponse({ error: 'Invalid email format' }, 400, corsHeaders);

  const turnstileSecret = env.TURNSTILE_SECRET;
  if (!turnstileSecret)
    return jsonResponse({ error: 'Turnstile is not configured on server' }, 500, corsHeaders);

  const clientIp = request.headers.get('CF-Connecting-IP') || undefined;
  const turnstileCheck = await verifyTurnstile(turnstile_token, turnstileSecret, clientIp);
  if (!turnstileCheck.success)
    return jsonResponse({ error: 'Turnstile verification failed', details: turnstileCheck['error-codes'] || [] }, 400, corsHeaders);

  const allowed = await checkRateLimit(db, clientIp || null);
  if (!allowed)
    return jsonResponse({ error: 'Rate limit exceeded. Please try again later.' }, 429, corsHeaders);

  try {
    const result = await db.prepare(`
      INSERT INTO suggestions (source_word, source_lang, english_word, mara_word,
        suggested_definition, suggested_example, notes, submitter_name, submitter_email)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).bind(source_word, source_lang, english_word, mara_word,
      suggested_definition, suggested_example, notes, submitter_name, submitter_email).run();

    return jsonResponse({ success: true, id: result.meta.last_row_id, message: 'Suggestion submitted successfully' }, 201, corsHeaders);
  } catch (err) {
    return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
  }
}

async function checkRateLimit(db, ip) {
  if (!ip) return true;
  const maxPerHour = 5;
  try {
    const windowStart = new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    const record = await db.prepare(
      'SELECT count, window_start FROM suggestion_rate_limits WHERE ip_hash = ?1'
    ).bind(ip).first();

    if (!record || record.window_start < windowStart) {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      await db.prepare(
        'INSERT OR REPLACE INTO suggestion_rate_limits (ip_hash, count, window_start) VALUES (?1, 1, ?2)'
      ).bind(ip, now).run();
      return true;
    }
    if (record.count >= maxPerHour) return false;
    await db.prepare('UPDATE suggestion_rate_limits SET count = count + 1 WHERE ip_hash = ?1').bind(ip).run();
    return true;
  } catch { return true; }
}

async function verifyTurnstile(token, secret, remoteip) {
  try {
    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', token);
    if (remoteip) form.set('remoteip', remoteip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) return { success: false, 'error-codes': ['turnstile-siteverify-http-error'] };
    return await res.json();
  } catch {
    return { success: false, 'error-codes': ['turnstile-siteverify-network-error'] };
  }
}

// ═══════════════════════════════════════════════════════════════
// ADMIN HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleAdmin(request, url, env, ctx, corsHeaders) {
  const db = env.DB;
  const method = request.method;

  try {
  // ── Authenticate & Authorize ──
  const auth = await authenticateAdmin(request, db);
  if (auth.error) {
    return jsonResponse({ error: auth.error }, auth.status, corsHeaders);
  }

  const { email, role } = auth;

  // ── GET /api/admin/me ──
  if (url.pathname === '/api/admin/me' && method === 'GET') {
    return jsonResponse({ email, role }, 200, corsHeaders);
  }

  // ── GET /api/admin/audit-logs ──
  if (url.pathname === '/api/admin/audit-logs' && method === 'GET') {
    if (!hasRole(role, 'senior_reviewer')) {
      return jsonResponse({ error: 'Senior reviewer role required' }, 403, corsHeaders);
    }
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '50', 10)));
    const offset = (page - 1) * perPage;

    try {
      const countResult = await db.prepare('SELECT COUNT(*) AS total FROM audit_logs').first();
      const total = countResult?.total || 0;
      const { results } = await db.prepare(`
        SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?1 OFFSET ?2
      `).bind(perPage, offset).all();
      return jsonResponse({ page, perPage, total, totalPages: Math.ceil(total / perPage), results }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // ═════════════════════════════════════════════
  // USER MANAGEMENT (super_admin only for mutations)
  // ═════════════════════════════════════════════

  if (url.pathname === '/api/admin/users' && method === 'GET') {
    if (!hasRole(role, 'super_admin')) {
      return jsonResponse({ error: 'Super admin role required' }, 403, corsHeaders);
    }
    try {
      const { results } = await db.prepare(
        'SELECT id, email, role, is_active, created_at FROM admin_users ORDER BY id ASC'
      ).all();
      return jsonResponse({ results }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  if (url.pathname === '/api/admin/users' && method === 'POST') {
    if (!hasRole(role, 'super_admin')) {
      return jsonResponse({ error: 'Super admin role required' }, 403, corsHeaders);
    }
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }

    const newEmail = String(body.email || '').trim().toLowerCase();
    const newRole = String(body.role || '').trim();
    if (!newEmail || !/^\S+@\S+\.\S+$/.test(newEmail))
      return jsonResponse({ error: 'Valid email is required' }, 400, corsHeaders);
    if (!['super_admin', 'senior_reviewer', 'reviewer'].includes(newRole))
      return jsonResponse({ error: 'Invalid role' }, 400, corsHeaders);

    try {
      const result = await db.prepare(
        'INSERT INTO admin_users (email, role) VALUES (?1, ?2)'
      ).bind(newEmail, newRole).run();

      await insertAuditLog(db, {
        action: 'create_user', table_name: 'admin_users', record_id: result.meta.last_row_id,
        performed_by: email, old_value: null, new_value: { email: newEmail, role: newRole },
      });

      const created = await db.prepare(
        'SELECT id, email, role, is_active, created_at FROM admin_users WHERE id = ?1'
      ).bind(result.meta.last_row_id).first();
      return jsonResponse({ success: true, user: created }, 201, corsHeaders);
    } catch (err) {
      if (err.message.includes('UNIQUE'))
        return jsonResponse({ error: 'Email already exists' }, 409, corsHeaders);
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  const userPutMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userPutMatch && method === 'PUT') {
    if (!hasRole(role, 'super_admin')) {
      return jsonResponse({ error: 'Super admin role required' }, 403, corsHeaders);
    }
    const userId = parseInt(userPutMatch[1], 10);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }

    try {
      const existing = await db.prepare('SELECT * FROM admin_users WHERE id = ?1').bind(userId).first();
      if (!existing) return jsonResponse({ error: 'User not found' }, 404, corsHeaders);

      const newRole = body.role !== undefined ? String(body.role).trim() : existing.role;
      const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;

      if (!['super_admin', 'senior_reviewer', 'reviewer'].includes(newRole))
        return jsonResponse({ error: 'Invalid role' }, 400, corsHeaders);

      await db.prepare('UPDATE admin_users SET role = ?1, is_active = ?2 WHERE id = ?3')
        .bind(newRole, isActive, userId).run();

      await insertAuditLog(db, {
        action: 'update_user', table_name: 'admin_users', record_id: userId,
        performed_by: email, old_value: existing,
        new_value: { ...existing, role: newRole, is_active: isActive },
      });

      const updated = await db.prepare(
        'SELECT id, email, role, is_active, created_at FROM admin_users WHERE id = ?1'
      ).bind(userId).first();
      return jsonResponse({ success: true, user: updated }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  const userDeleteMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userDeleteMatch && method === 'DELETE') {
    if (!hasRole(role, 'super_admin')) {
      return jsonResponse({ error: 'Super admin role required' }, 403, corsHeaders);
    }
    const userId = parseInt(userDeleteMatch[1], 10);
    try {
      const existing = await db.prepare('SELECT * FROM admin_users WHERE id = ?1').bind(userId).first();
      if (!existing) return jsonResponse({ error: 'User not found' }, 404, corsHeaders);
      if (existing.email === email)
        return jsonResponse({ error: 'Cannot delete your own account' }, 400, corsHeaders);

      await db.prepare('DELETE FROM admin_users WHERE id = ?1').bind(userId).run();
      await insertAuditLog(db, {
        action: 'delete_user', table_name: 'admin_users', record_id: userId,
        performed_by: email, old_value: existing, new_value: null,
      });
      return jsonResponse({ success: true, deleted_id: userId }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // ═════════════════════════════════════════════
  // REVISIONS
  // ═════════════════════════════════════════════

  if (url.pathname === '/api/admin/revisions' && method === 'GET') {
    const status = (url.searchParams.get('status') || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '50', 10)));
    const offset = (page - 1) * perPage;

    try {
      let whereClause = '';
      const bindings = [];
      if (status && ['pending', 'approved', 'rejected'].includes(status)) {
        bindings.push(status);
        whereClause = 'WHERE r.status = ?1';
      }

      const countResult = await db.prepare(
        `SELECT COUNT(*) AS total FROM word_revisions r ${whereClause}`
      ).bind(...bindings).first();
      const total = countResult?.total || 0;

      const paginationBindings = [...bindings, perPage, offset];
      const limitIndex = bindings.length + 1;
      const { results } = await db.prepare(`
        SELECT r.*, d.english_word, d.mara_word, d.version AS current_version
        FROM word_revisions r
        LEFT JOIN dictionary d ON d.id = r.word_id
        ${whereClause}
        ORDER BY r.id DESC
        LIMIT ?${limitIndex} OFFSET ?${limitIndex + 1}
      `).bind(...paginationBindings).all();

      return jsonResponse({ page, perPage, total, totalPages: Math.ceil(total / perPage), results }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  const revGetMatch = url.pathname.match(/^\/api\/admin\/revisions\/(\d+)$/);
  if (revGetMatch && method === 'GET') {
    const revId = parseInt(revGetMatch[1], 10);
    try {
      const revision = await db.prepare(`
        SELECT r.*, d.english_word, d.mara_word, d.part_of_speech, d.definition, d.example_sentence,
               d.version AS current_version, d.status AS word_status
        FROM word_revisions r
        LEFT JOIN dictionary d ON d.id = r.word_id
        WHERE r.id = ?1
      `).bind(revId).first();
      if (!revision) return jsonResponse({ error: 'Revision not found' }, 404, corsHeaders);
      return jsonResponse({ revision }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  const revApproveMatch = url.pathname.match(/^\/api\/admin\/revisions\/(\d+)\/approve$/);
  if (revApproveMatch && method === 'POST') {
    if (!hasRole(role, 'senior_reviewer')) {
      return jsonResponse({ error: 'Senior reviewer role required to approve revisions' }, 403, corsHeaders);
    }
    const revId = parseInt(revApproveMatch[1], 10);

    try {
      const revision = await db.prepare('SELECT * FROM word_revisions WHERE id = ?1').bind(revId).first();
      if (!revision) return jsonResponse({ error: 'Revision not found' }, 404, corsHeaders);
      if (revision.status !== 'pending')
        return jsonResponse({ error: `Revision is already ${revision.status}` }, 400, corsHeaders);

      const oldWord = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(revision.word_id).first();
      if (!oldWord) return jsonResponse({ error: 'Associated word not found' }, 404, corsHeaders);

      const newVersion = (oldWord.version || 1) + 1;
      const now = new Date().toISOString();

      const newEnglish = revision.proposed_english_word || oldWord.english_word;
      const newMara = revision.proposed_mara_word || oldWord.mara_word;
      const newDef = revision.proposed_definition !== null ? revision.proposed_definition : oldWord.definition;
      const newExample = revision.proposed_example !== null ? revision.proposed_example : oldWord.example_sentence;
      const newPos = revision.proposed_part_of_speech !== null ? revision.proposed_part_of_speech : oldWord.part_of_speech;

      await db.prepare(`
        UPDATE dictionary SET
          english_word = ?1, mara_word = ?2, part_of_speech = ?3,
          definition = ?4, example_sentence = ?5,
          version = ?6, approved_by = ?7, approved_at = ?8,
          updated_by = ?9, updated_at = ?8, status = 'approved'
        WHERE id = ?10
      `).bind(
        newEnglish, newMara, newPos, newDef, newExample,
        newVersion, email, now, email, revision.word_id
      ).run();

      if (revision.proposed_meanings) {
        try {
          const meaningsList = JSON.parse(revision.proposed_meanings);
          if (Array.isArray(meaningsList)) {
            await db.prepare('DELETE FROM meanings WHERE dictionary_id = ?1').bind(revision.word_id).run();
            for (let i = 0; i < meaningsList.length; i++) {
              const m = meaningsList[i];
              if (!m.definition?.trim()) continue;
              const exJson = m.example?.trim() ? JSON.stringify([m.example.trim()]) : null;
              const synJson = Array.isArray(m.synonyms) && m.synonyms.length ? JSON.stringify(m.synonyms) : null;
              const antJson = Array.isArray(m.antonyms) && m.antonyms.length ? JSON.stringify(m.antonyms) : null;
              await db.prepare(
                `INSERT INTO meanings (dictionary_id, part_of_speech, definition, examples, synonyms, antonyms, "order")
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
              ).bind(revision.word_id, m.part_of_speech || null, m.definition.trim(), exJson, synJson, antJson, i).run();
            }
          }
        } catch { /* invalid JSON — skip */ }
      }

      await db.prepare(`
        UPDATE word_revisions SET status = 'approved', reviewed_by = ?1, reviewed_at = ?2 WHERE id = ?3
      `).bind(email, now, revId).run();

      const newWord = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(revision.word_id).first();
      await insertAuditLog(db, {
        action: 'approve_revision', table_name: 'dictionary', record_id: revision.word_id,
        performed_by: email, old_value: oldWord, new_value: newWord,
      });

      ctx.waitUntil(syncToGitHub(env, db, `Approve revision: ${newWord.english_word} v${newWord.version} by ${email}`));

      return jsonResponse({ success: true, entry: newWord, github: 'syncing' }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  const revRejectMatch = url.pathname.match(/^\/api\/admin\/revisions\/(\d+)\/reject$/);
  if (revRejectMatch && method === 'POST') {
    if (!hasRole(role, 'senior_reviewer')) {
      return jsonResponse({ error: 'Senior reviewer role required to reject revisions' }, 403, corsHeaders);
    }
    const revId = parseInt(revRejectMatch[1], 10);
    let body = {};
    try { body = await request.json(); } catch { /* ok */ }

    try {
      const revision = await db.prepare('SELECT * FROM word_revisions WHERE id = ?1').bind(revId).first();
      if (!revision) return jsonResponse({ error: 'Revision not found' }, 404, corsHeaders);
      if (revision.status !== 'pending')
        return jsonResponse({ error: `Revision is already ${revision.status}` }, 400, corsHeaders);

      const now = new Date().toISOString();
      const reviewNote = String(body.note || body.reason || '').trim() || null;

      await db.prepare(`
        UPDATE word_revisions SET status = 'rejected', reviewed_by = ?1, reviewed_at = ?2, review_note = ?3 WHERE id = ?4
      `).bind(email, now, reviewNote, revId).run();

      await insertAuditLog(db, {
        action: 'reject_revision', table_name: 'word_revisions', record_id: revId,
        performed_by: email, old_value: revision,
        new_value: { ...revision, status: 'rejected', reviewed_by: email, reviewed_at: now, review_note: reviewNote },
      });

      return jsonResponse({ success: true, revision_id: revId, status: 'rejected' }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // ═════════════════════════════════════════════
  // SUGGESTIONS (existing, preserved)
  // ═════════════════════════════════════════════

  if (url.pathname === '/api/admin/suggestions' && method === 'GET') {
    const page    = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '50', 10)));
    const offset  = (page - 1) * perPage;
    const q       = (url.searchParams.get('q') || '').trim();
    const status  = (url.searchParams.get('status') || '').trim().toLowerCase();

    try {
      const whereParts = [];
      const bindings = [];
      if (q) {
        bindings.push(`%${q.toLowerCase()}%`);
        const idx = bindings.length;
        whereParts.push(`(LOWER(source_word) LIKE ?${idx} OR LOWER(suggested_definition) LIKE ?${idx})`);
      }
      if (status) {
        bindings.push(status);
        whereParts.push(`LOWER(status) = ?${bindings.length}`);
      }
      const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      const countResult = await db.prepare(`SELECT COUNT(*) AS total FROM suggestions ${whereClause}`)
        .bind(...bindings).first();
      const total = countResult?.total || 0;

      const paginationBindings = [...bindings, perPage, offset];
      const limitIndex = bindings.length + 1;
      const { results } = await db.prepare(`
        SELECT id, source_word, source_lang, english_word, mara_word,
               suggested_definition, suggested_example, notes,
               submitter_name, submitter_email, status, created_at
        FROM suggestions ${whereClause}
        ORDER BY id DESC LIMIT ?${limitIndex} OFFSET ?${limitIndex + 1}
      `).bind(...paginationBindings).all();

      return jsonResponse({ page, perPage, total, totalPages: Math.ceil(total / perPage), results }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  const meaningsGetMatch = url.pathname.match(/^\/api\/admin\/entries\/(\d+)\/meanings$/);
  if (meaningsGetMatch && method === 'GET') {
    const id = parseInt(meaningsGetMatch[1], 10);
    try {
      const { results } = await db.prepare(`
        SELECT id, part_of_speech, definition, examples, synonyms, antonyms, "order"
        FROM meanings WHERE dictionary_id = ?1 ORDER BY "order" ASC, id ASC
      `).bind(id).all();
      return jsonResponse({ results }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // GET /api/admin/stats — full stats including pending
  if (url.pathname === '/api/admin/stats' && method === 'GET') {
    try {
      const row = await db.prepare(`
        SELECT
          COUNT(*) AS total_entries,
          COUNT(DISTINCT english_word) AS unique_english,
          COUNT(DISTINCT CASE WHEN mara_word != '' THEN mara_word END) AS unique_mara,
          SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
          SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
          COUNT(CASE WHEN definition IS NOT NULL AND definition != '' THEN 1 END) AS with_definition,
          COUNT(CASE WHEN example_sentence IS NOT NULL AND example_sentence != '' THEN 1 END) AS with_example
        FROM dictionary
      `).first();
      return jsonResponse(row, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500, corsHeaders);
    }
  }

  // ═════════════════════════════════════════════
  // ENTRIES CRUD (with editorial workflow)
  // ═════════════════════════════════════════════

  if (url.pathname === '/api/admin/entries' && method === 'GET') {
    const page    = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '50', 10)));
    const offset  = (page - 1) * perPage;
    const q       = (url.searchParams.get('q') || '').trim();
    const lang    = (url.searchParams.get('lang') || '').toLowerCase();
    const statusFilter = (url.searchParams.get('status') || '').trim().toLowerCase();

    try {
      const whereParts = [];
      let bindings = [];

      if (q) {
        const terms = q.replace(/["^*()[\]{}:!]/g, ' ').trim().split(/\s+/).filter(Boolean);
        if (terms.length) {
          const ftsCol = lang === 'mrh' ? 'mara_word' : 'english_word';
          const ftsQuery = terms.map(t => `${ftsCol}:${t}*`).join(' ');
          bindings.push(ftsQuery);
          whereParts.push(`id IN (SELECT rowid FROM dictionary_fts WHERE dictionary_fts MATCH ?${bindings.length})`);
        }
      }

      if (statusFilter && ['approved', 'archived', 'pending'].includes(statusFilter)) {
        bindings.push(statusFilter);
        whereParts.push(`status = ?${bindings.length}`);
      }

      const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      const countResult = await db.prepare(
        `SELECT COUNT(*) AS total FROM dictionary ${whereClause}`
      ).bind(...bindings).first();
      const total = countResult?.total || 0;

      const paginationBindings = [...bindings, perPage, offset];
      const limitIndex = bindings.length + 1;
      const { results } = await db.prepare(`
        SELECT id, english_word, mara_word, part_of_speech, definition, example_sentence,
               status, version, approved_by, approved_at, updated_by, updated_at, created_at
        FROM dictionary ${whereClause}
        ORDER BY english_word ASC
        LIMIT ?${limitIndex} OFFSET ?${limitIndex + 1}
      `).bind(...paginationBindings).all();

      return jsonResponse({ page, perPage, total, totalPages: Math.ceil(total / perPage), results }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  if (url.pathname === '/api/admin/entries' && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }

    const { english_word, mara_word } = body;
    if (!english_word || !mara_word)
      return jsonResponse({ error: 'english_word and mara_word are required' }, 400, corsHeaders);

    const meaningsList = Array.isArray(body.meanings) && body.meanings.length > 0 ? body.meanings : null;
    const first = meaningsList ? meaningsList[0] : body;
    const part_of_speech   = first.part_of_speech?.trim() || null;
    const definition       = first.definition?.trim() || null;
    const example_sentence = (first.example || first.example_sentence || '').trim() || null;
    const now = new Date().toISOString();

    try {
      const result = await db.prepare(`
        INSERT INTO dictionary (english_word, mara_word, part_of_speech, definition, example_sentence,
                                status, version, approved_by, approved_at, updated_by, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 'approved', 1, ?6, ?7, ?6, ?7)
      `).bind(
        english_word.trim(), mara_word.trim(), part_of_speech, definition, example_sentence,
        email, now
      ).run();

      const entryId = result.meta.last_row_id;

      if (meaningsList) {
        for (let i = 0; i < meaningsList.length; i++) {
          const m = meaningsList[i];
          if (!m.definition?.trim()) continue;
          const exJson = m.example?.trim() ? JSON.stringify([m.example.trim()]) : null;
          const synJson = Array.isArray(m.synonyms) && m.synonyms.length ? JSON.stringify(m.synonyms) : null;
          const antJson = Array.isArray(m.antonyms) && m.antonyms.length ? JSON.stringify(m.antonyms) : null;
          await db.prepare(
            `INSERT INTO meanings (dictionary_id, part_of_speech, definition, examples, synonyms, antonyms, "order")
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
          ).bind(entryId, m.part_of_speech?.trim() || null, m.definition.trim(), exJson, synJson, antJson, i).run();
        }
      }

      const created = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(entryId).first();

      await insertAuditLog(db, {
        action: 'create_entry', table_name: 'dictionary', record_id: entryId,
        performed_by: email, old_value: null, new_value: created,
      });

      ctx.waitUntil(syncToGitHub(env, db, `Create entry: ${english_word} by ${email}`));

      return jsonResponse({ success: true, entry: created, github: 'syncing' }, 201, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  const putMatch = url.pathname.match(/^\/api\/admin\/entries\/(\d+)$/);
  if (putMatch && method === 'PUT') {
    const id = parseInt(putMatch[1], 10);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }

    const { english_word, mara_word } = body;
    if (!english_word || !mara_word)
      return jsonResponse({ error: 'english_word and mara_word are required' }, 400, corsHeaders);

    try {
      const existing = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();
      if (!existing) return jsonResponse({ error: 'Entry not found' }, 404, corsHeaders);

      const meaningsList = Array.isArray(body.meanings) && body.meanings.length > 0 ? body.meanings : null;
      const first = meaningsList ? meaningsList[0] : body;
      const part_of_speech   = first.part_of_speech?.trim() || null;
      const definition       = first.definition?.trim() || null;
      const example_sentence = (first.example || first.example_sentence || '').trim() || null;

      // Reviewer: create revision instead of direct update
      if (role === 'reviewer') {
        const result = await db.prepare(`
          INSERT INTO word_revisions
            (word_id, proposed_english_word, proposed_mara_word, proposed_definition,
             proposed_example, proposed_part_of_speech, proposed_meanings, created_by)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        `).bind(
          id,
          english_word.trim(),
          mara_word.trim(),
          definition,
          example_sentence,
          part_of_speech,
          meaningsList ? JSON.stringify(meaningsList) : null,
          email,
        ).run();

        await insertAuditLog(db, {
          action: 'create_revision', table_name: 'word_revisions', record_id: result.meta.last_row_id,
          performed_by: email, old_value: existing,
          new_value: { proposed_english_word: english_word, proposed_mara_word: mara_word, proposed_definition: definition },
        });

        return jsonResponse({
          success: true,
          revision: true,
          revision_id: result.meta.last_row_id,
          message: 'Revision created. Awaiting senior reviewer approval.',
        }, 202, corsHeaders);
      }

      // Senior reviewer / super admin: direct update with version increment
      const newVersion = (existing.version || 1) + 1;
      const now = new Date().toISOString();

      await db.prepare(`
        UPDATE dictionary SET
          english_word = ?1, mara_word = ?2, part_of_speech = ?3,
          definition = ?4, example_sentence = ?5,
          version = ?6, approved_by = ?7, approved_at = ?8,
          updated_by = ?7, updated_at = ?8
        WHERE id = ?9
      `).bind(
        english_word.trim(), mara_word.trim(), part_of_speech, definition, example_sentence,
        newVersion, email, now, id
      ).run();

      if (meaningsList) {
        await db.prepare('DELETE FROM meanings WHERE dictionary_id = ?1').bind(id).run();
        for (let i = 0; i < meaningsList.length; i++) {
          const m = meaningsList[i];
          if (!m.definition?.trim()) continue;
          const exJson = m.example?.trim() ? JSON.stringify([m.example.trim()]) : null;
          const synJson = Array.isArray(m.synonyms) && m.synonyms.length ? JSON.stringify(m.synonyms) : null;
          const antJson = Array.isArray(m.antonyms) && m.antonyms.length ? JSON.stringify(m.antonyms) : null;
          await db.prepare(
            `INSERT INTO meanings (dictionary_id, part_of_speech, definition, examples, synonyms, antonyms, "order")
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
          ).bind(id, m.part_of_speech?.trim() || null, m.definition.trim(), exJson, synJson, antJson, i).run();
        }
      }

      const updated = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();

      await insertAuditLog(db, {
        action: 'update_entry', table_name: 'dictionary', record_id: id,
        performed_by: email, old_value: existing, new_value: updated,
      });

      ctx.waitUntil(syncToGitHub(env, db, `Update entry: ${updated.english_word} v${updated.version} by ${email}`));

      return jsonResponse({ success: true, entry: updated, github: 'syncing' }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // POST /api/admin/entries/:id/unpublish — roll back approved entry to pending
  const unpublishEntryMatch = url.pathname.match(/^\/api\/admin\/entries\/(\d+)\/unpublish$/);
  if (unpublishEntryMatch && method === 'POST') {
    const id = parseInt(unpublishEntryMatch[1], 10);
    try {
      const existing = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();
      if (!existing) return jsonResponse({ error: 'Entry not found' }, 404, corsHeaders);
      if (existing.status !== 'approved')
        return jsonResponse({ error: 'Entry is not currently approved' }, 400, corsHeaders);

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE dictionary SET status = 'pending', updated_by = ?1, updated_at = ?2 WHERE id = ?3`
      ).bind(email, now, id).run();

      const updated = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();
      await insertAuditLog(db, {
        action: 'unpublish_entry', table_name: 'dictionary', record_id: id,
        performed_by: email, old_value: existing, new_value: updated,
      });
      ctx.waitUntil(syncToGitHub(env, db, `Unpublish entry #${id} (${existing.english_word}) by ${email}`));
      return jsonResponse({ success: true, entry: updated }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // POST /api/admin/entries/:id/approve — set status to approved (publish)
  const approveEntryMatch = url.pathname.match(/^\/api\/admin\/entries\/(\d+)\/approve$/);
  if (approveEntryMatch && method === 'POST') {
    const id = parseInt(approveEntryMatch[1], 10);
    try {
      const existing = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();
      if (!existing) return jsonResponse({ error: 'Entry not found' }, 404, corsHeaders);
      if (existing.status === 'approved')
        return jsonResponse({ error: 'Entry is already approved' }, 400, corsHeaders);

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE dictionary SET status = 'approved', approved_by = ?1, approved_at = ?2, updated_by = ?1, updated_at = ?2 WHERE id = ?3`
      ).bind(email, now, id).run();

      const updated = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();
      await insertAuditLog(db, {
        action: 'approve_entry', table_name: 'dictionary', record_id: id,
        performed_by: email, old_value: existing, new_value: updated,
      });
      return jsonResponse({ success: true, entry: updated }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // POST /api/admin/entries/:id/archive — soft delete
  const archiveMatch = url.pathname.match(/^\/api\/admin\/entries\/(\d+)\/archive$/);
  if (archiveMatch && method === 'POST') {
    if (!hasRole(role, 'senior_reviewer')) {
      return jsonResponse({ error: 'Senior reviewer role required to archive entries' }, 403, corsHeaders);
    }
    const id = parseInt(archiveMatch[1], 10);
    let body = {};
    try { body = await request.json(); } catch { /* ok */ }

    const reason = String(body.reason || '').trim();
    if (!reason)
      return jsonResponse({ error: 'Archive reason is required' }, 400, corsHeaders);

    try {
      const existing = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();
      if (!existing) return jsonResponse({ error: 'Entry not found' }, 404, corsHeaders);
      if (existing.status === 'archived')
        return jsonResponse({ error: 'Entry is already archived' }, 400, corsHeaders);

      const now = new Date().toISOString();
      await db.prepare(`
        UPDATE dictionary SET status = 'archived', updated_by = ?1, updated_at = ?2 WHERE id = ?3
      `).bind(email, now, id).run();

      const updated = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();

      await insertAuditLog(db, {
        action: 'archive_entry', table_name: 'dictionary', record_id: id,
        performed_by: email, old_value: existing,
        new_value: { ...updated, archive_reason: reason },
      });

      ctx.waitUntil(syncToGitHub(env, db, `Archive entry #${id} (${existing.english_word}) by ${email}`));

      return jsonResponse({ success: true, entry: updated }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // POST /api/admin/entries/:id/restore
  const restoreMatch = url.pathname.match(/^\/api\/admin\/entries\/(\d+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    if (!hasRole(role, 'senior_reviewer')) {
      return jsonResponse({ error: 'Senior reviewer role required to restore entries' }, 403, corsHeaders);
    }
    const id = parseInt(restoreMatch[1], 10);

    try {
      const existing = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();
      if (!existing) return jsonResponse({ error: 'Entry not found' }, 404, corsHeaders);
      if (existing.status !== 'archived')
        return jsonResponse({ error: 'Entry is not archived' }, 400, corsHeaders);

      const now = new Date().toISOString();
      await db.prepare(`
        UPDATE dictionary SET status = 'approved', updated_by = ?1, updated_at = ?2 WHERE id = ?3
      `).bind(email, now, id).run();

      const updated = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();

      await insertAuditLog(db, {
        action: 'restore_entry', table_name: 'dictionary', record_id: id,
        performed_by: email, old_value: existing, new_value: updated,
      });

      ctx.waitUntil(syncToGitHub(env, db, `Restore entry #${id} (${existing.english_word}) by ${email}`));

      return jsonResponse({ success: true, entry: updated }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // DELETE /api/admin/entries/:id — BLOCKED (no hard deletes)
  const deleteMatch = url.pathname.match(/^\/api\/admin\/entries\/(\d+)$/);
  if (deleteMatch && method === 'DELETE') {
    return jsonResponse({
      error: 'Hard deletes are not allowed. Use POST /api/admin/entries/:id/archive instead.',
    }, 403, corsHeaders);
  }

  // PATCH /api/admin/suggestions/:id
  const suggPatchMatch = url.pathname.match(/^\/api\/admin\/suggestions\/(\d+)$/);
  if (suggPatchMatch && method === 'PATCH') {
    const id = parseInt(suggPatchMatch[1], 10);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }

    try {
      const existing = await db.prepare('SELECT * FROM suggestions WHERE id = ?1').bind(id).first();
      if (!existing) return jsonResponse({ error: 'Suggestion not found' }, 404, corsHeaders);

      const VALID_STATUSES = ['new', 'pending', 'approved', 'rejected'];
      const status = body.status !== undefined ? String(body.status).trim().toLowerCase() : existing.status;
      if (!VALID_STATUSES.includes(status))
        return jsonResponse({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, 400, corsHeaders);

      const source_word          = body.source_word !== undefined          ? String(body.source_word).trim()               : existing.source_word;
      const source_lang          = body.source_lang !== undefined          ? String(body.source_lang).trim().toLowerCase() : existing.source_lang;
      const suggested_definition = body.suggested_definition !== undefined ? String(body.suggested_definition).trim()      : existing.suggested_definition;
      const notes                = body.notes !== undefined                ? (String(body.notes).trim() || null)            : existing.notes;
      const submitter_name       = body.submitter_name !== undefined       ? (String(body.submitter_name).trim() || null)   : existing.submitter_name;
      const submitter_email      = body.submitter_email !== undefined      ? (String(body.submitter_email).trim() || null)  : existing.submitter_email;

      if (!source_word || !suggested_definition)
        return jsonResponse({ error: 'source_word and suggested_definition are required' }, 400, corsHeaders);
      if (source_lang !== 'en' && source_lang !== 'mrh')
        return jsonResponse({ error: 'Invalid source_lang. Use "en" or "mrh".' }, 400, corsHeaders);

      await db.prepare(`
        UPDATE suggestions
        SET source_word = ?1, source_lang = ?2, suggested_definition = ?3,
            notes = ?4, submitter_name = ?5, submitter_email = ?6, status = ?7
        WHERE id = ?8
      `).bind(source_word, source_lang, suggested_definition, notes, submitter_name, submitter_email, status, id).run();

      const updated = await db.prepare('SELECT * FROM suggestions WHERE id = ?1').bind(id).first();

      await insertAuditLog(db, {
        action: 'update_suggestion', table_name: 'suggestions', record_id: id,
        performed_by: email, old_value: existing, new_value: updated,
      });

      return jsonResponse({ success: true, suggestion: updated }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // DELETE /api/admin/suggestions/:id
  const suggDeleteMatch = url.pathname.match(/^\/api\/admin\/suggestions\/(\d+)$/);
  if (suggDeleteMatch && method === 'DELETE') {
    const id = parseInt(suggDeleteMatch[1], 10);
    try {
      const existing = await db.prepare('SELECT * FROM suggestions WHERE id = ?1').bind(id).first();
      if (!existing) return jsonResponse({ error: 'Suggestion not found' }, 404, corsHeaders);

      await db.prepare('DELETE FROM suggestions WHERE id = ?1').bind(id).run();

      await insertAuditLog(db, {
        action: 'delete_suggestion', table_name: 'suggestions', record_id: id,
        performed_by: email, old_value: existing, new_value: null,
      });

      return jsonResponse({ success: true, deleted_id: id }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // ═════════════════════════════════════════════════════════════
  // GITHUB SYNC — Glottolog editorial workflow
  //   GET  /api/admin/github/status   — last commit + D1 count
  //   POST /api/admin/github/sync     — D1 → GitHub full export
  //   POST /api/admin/github/publish  — GitHub JSON → D1 (publish live)
  // ═════════════════════════════════════════════════════════════

  if (url.pathname === '/api/admin/github/status' && method === 'GET') {
    if (!hasRole(role, 'senior_reviewer'))
      return jsonResponse({ error: 'Senior reviewer role required' }, 403, corsHeaders);
    const cfg = ghConfig(env);
    if (!env.GITHUB_TOKEN)
      return jsonResponse({ configured: false, reason: 'GITHUB_TOKEN not set on the worker' }, 200, corsHeaders);
    try {
      const [lastCommit, dbCount] = await Promise.all([
        ghGetLastCommit(env.GITHUB_TOKEN, cfg.owner, cfg.repo, cfg.jsonPath, cfg.branch),
        db.prepare("SELECT COUNT(*) AS total FROM dictionary WHERE status != 'archived'").first(),
      ]);
      return jsonResponse({
        configured: true,
        repo:        `${cfg.owner}/${cfg.repo}`,
        branch:      cfg.branch,
        sql_file:    cfg.sqlPath,
        json_file:   cfg.jsonPath,
        last_commit: lastCommit,
        db_entries:  dbCount?.total || 0,
      }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'GitHub status check failed', details: err.message }, 500, corsHeaders);
    }
  }

  if (url.pathname === '/api/admin/github/sync' && method === 'POST') {
    if (!hasRole(role, 'senior_reviewer'))
      return jsonResponse({ error: 'Senior reviewer role required' }, 403, corsHeaders);
    if (!env.GITHUB_TOKEN)
      return jsonResponse({ error: 'GITHUB_TOKEN not configured on this worker' }, 503, corsHeaders);
    try {
      // Query entry count synchronously (fast D1 read)
      const countRow = await db.prepare("SELECT COUNT(*) AS total FROM dictionary WHERE status != 'archived'").first();
      const total = countRow?.total || 0;
      const commitMsg = `Manual sync: ${total} entries — by ${email}`;
      const syncedBy = email;

      // Fire GitHub push in background — avoids 30s wall-clock timeout from outbound HTTP calls
      ctx.waitUntil((async () => {
        try {
          console.log('[sync:bg] starting for', syncedBy, '—', total, 'entries');
          const result = await syncToGitHub(env, db, commitMsg);
          console.log('[sync:bg] result:', JSON.stringify(result));
          await insertAuditLog(db, {
            action: 'github_sync', table_name: 'dictionary', record_id: null,
            performed_by: syncedBy, old_value: null,
            new_value: { total_entries: total, commit_sha: result.commit_sha, success: result.success },
          });
        } catch (err) {
          console.error('[sync:bg] error:', err.message);
        }
      })());

      return jsonResponse({
        success: true,
        queued: true,
        total_entries: total,
        message: `Sync started for ${total} entries. Check GitHub in a few seconds.`,
      }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'GitHub sync error', details: err.message }, 500, corsHeaders);
    }
  }

  if (url.pathname === '/api/admin/github/publish' && method === 'POST') {
    if (!hasRole(role, 'super_admin'))
      return jsonResponse({ error: 'Super admin role required to publish from GitHub' }, 403, corsHeaders);
    if (!env.GITHUB_TOKEN)
      return jsonResponse({ error: 'GITHUB_TOKEN not configured on this worker' }, 503, corsHeaders);
    try {
      const cfg = ghConfig(env);
      const jsonContent = await ghFetchFileContent(env.GITHUB_TOKEN, cfg.owner, cfg.repo, cfg.jsonPath, cfg.branch);
      const data = JSON.parse(jsonContent);
      const entries = data.entries;
      if (!Array.isArray(entries))
        return jsonResponse({ error: 'Invalid dictionary-data.json: missing entries array' }, 422, corsHeaders);

      // Snapshot for audit
      const beforeCount = (await db.prepare('SELECT COUNT(*) AS c FROM dictionary').first())?.c || 0;

      // Atomic batch: clear + re-insert entire dictionary from GitHub
      const batch = [
        db.prepare('DELETE FROM dictionary'),
        db.prepare("DELETE FROM sqlite_sequence WHERE name='dictionary'"),
      ];
      const now = new Date().toISOString();
      for (const e of entries) {
        batch.push(
          db.prepare(
            `INSERT INTO dictionary
               (id, english_word, mara_word, part_of_speech, definition, example_sentence,
                status, version, approved_by, approved_at, updated_by, updated_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
          ).bind(
            e.id,
            e.english_word, e.mara_word, e.part_of_speech || null,
            e.definition || null, e.example_sentence || null,
            e.status || 'approved', e.version || 1,
            e.approved_by || email, e.approved_at || now,
            e.updated_by  || email, e.updated_at  || now,
            e.created_at  || now
          )
        );
      }
      await db.batch(batch);

      await insertAuditLog(db, {
        action: 'github_publish', table_name: 'dictionary', record_id: null,
        performed_by: email,
        old_value: { count: beforeCount },
        new_value: { count: entries.length, source: `${cfg.owner}/${cfg.repo}@${cfg.branch}:${cfg.jsonPath}` },
      });

      return jsonResponse({
        success: true,
        published: entries.length,
        previous_count: beforeCount,
        source: `${cfg.owner}/${cfg.repo}@${cfg.branch}:${cfg.jsonPath}`,
      }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Publish failed', details: err.message }, 500, corsHeaders);
    }
  }

  return jsonResponse({ error: 'Admin route not found' }, 404, corsHeaders);
  } catch (err) {
    console.error('Unhandled admin error:', err);
    return jsonResponse({ error: 'Internal server error', details: err.message }, 500, corsHeaders);
  }
}

// ═══════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}