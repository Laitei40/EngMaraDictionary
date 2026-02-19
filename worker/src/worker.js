/**
 * English ⇄ Mara Dictionary — Cloudflare Worker API
 *
 * Public Endpoints:
 *   GET /api/search?q=<query>&lang=en|mrh          — Dictionary search
 *   GET /api/suggest?q=<prefix>&lang=en|mrh         — Autocomplete suggestions
 *   GET /api/word?q=<word>&lang=en|mrh              — Exact word lookup (definition page)
 *   GET /api/browse?letter=<A-Z>&lang=en|mrh&page=1 — Browse words alphabetically
 *   GET /api/stats                                  — Dictionary statistics
 *   GET /api/health                                 — Health check
 *   POST /api/suggestions                            — Submit word improvement suggestion
 *
 * Admin CRUD Endpoints (protected by Cloudflare Access):
 *   GET    /api/admin/entries?page=1&q=<filter>     — List all entries (paginated)
 *   POST   /api/admin/entries                       — Create a new entry
 *   PUT    /api/admin/entries/:id                   — Update an existing entry
 *   DELETE /api/admin/entries/:id                   — Delete an entry
 *   GET    /api/admin/suggestions                   — List user suggestions
 *
 * Binds to a Cloudflare D1 database named DB.
 * Set the ADMIN_KEY secret:  npx wrangler secret put ADMIN_KEY
 *
 * Authentication for admin routes is handled by Cloudflare Access.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Admin CRUD routes — skip the GET-only guard for /api/admin/*
    if (url.pathname.startsWith('/api/admin/')) {
      return await handleAdmin(request, url, env, corsHeaders);
    }

    // Public suggestion submit route
    if (url.pathname === '/api/suggestions') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
      }
      return await handleSuggestionSubmit(request, env.DB, corsHeaders);
    }

    // Only allow GET and HEAD for public routes
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    try {
      // Route requests
      if (url.pathname === '/api/search') {
        return await handleSearch(url, env.DB, corsHeaders);
      }

      if (url.pathname === '/api/suggest') {
        return await handleSuggest(url, env.DB, corsHeaders);
      }

      if (url.pathname === '/api/word') {
        return await handleWord(url, env.DB, corsHeaders);
      }

      if (url.pathname === '/api/browse') {
        return await handleBrowse(url, env.DB, corsHeaders);
      }

      if (url.pathname === '/api/stats') {
        return await handleStats(env.DB, corsHeaders);
      }

      if (url.pathname === '/api/health') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() }, 200, corsHeaders);
      }

      // Serve a simple test page at root
      if (url.pathname === '/' || url.pathname === '') {
        return new Response(`
          <!DOCTYPE html>
          <html>
          <head><title>Mara Dictionary API</title></head>
          <body>
            <h1>Mara Dictionary API</h1>
            <p>Endpoints:</p>
            <ul>
              <li><a href="/api/health">/api/health</a> - Health check</li>
              <li><a href="/api/search?q=water&lang=en">/api/search?q=water&lang=en</a> - Search English</li>
              <li><a href="/api/search?q=ti&lang=mrh">/api/search?q=ti&lang=mrh</a> - Search Mara</li>
            </ul>
          </body>
          </html>
        `, { status: 200, headers: { 'Content-Type': 'text/html', ...corsHeaders } });
      }

      return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal server error', details: err.message }, 500, corsHeaders);
    }
  },
};

/**
 * Handle dictionary search requests.
 * GET /api/search?q=<query>&lang=en|mrh
 */
async function handleSearch(url, db, corsHeaders) {
  const query = (url.searchParams.get('q') || '').trim();
  const lang  = (url.searchParams.get('lang') || 'en').toLowerCase();

  // Validate
  if (!query) {
    return jsonResponse({ error: 'Missing search query. Use ?q=word' }, 400, corsHeaders);
  }

  if (query.length > 100) {
    return jsonResponse({ error: 'Query too long (max 100 characters)' }, 400, corsHeaders);
  }

  if (lang !== 'en' && lang !== 'mrh') {
    return jsonResponse({ error: 'Invalid lang parameter. Use "en" or "mrh".' }, 400, corsHeaders);
  }

  const searchColumn = lang === 'en' ? 'english_word' : 'mara_word';
  const lowerQuery = query.toLowerCase();

  // Search strategy:
  // 1. Exact match (case-insensitive)
  // 2. Prefix match
  // 3. Contains match
  // Results are ordered: exact → prefix → contains
  const sql = `
    SELECT
      id,
      english_word,
      mara_word,
      part_of_speech,
      definition,
      example_sentence
    FROM dictionary
    WHERE LOWER(${searchColumn}) = ?1
       OR LOWER(${searchColumn}) LIKE ?2
       OR LOWER(${searchColumn}) LIKE ?3
    ORDER BY
      CASE
        WHEN LOWER(${searchColumn}) = ?1 THEN 0
        WHEN LOWER(${searchColumn}) LIKE ?2 THEN 1
        ELSE 2
      END,
      ${searchColumn} ASC
    LIMIT 50
  `;

  const prefixPattern   = `${lowerQuery}%`;
  const containsPattern = `%${lowerQuery}%`;

  try {
    const { results } = await db.prepare(sql)
      .bind(lowerQuery, prefixPattern, containsPattern)
      .all();

    return jsonResponse(
      { query, lang, count: results.length, results },
      200,
      {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=300', // 5-minute edge cache
      }
    );
  } catch (dbErr) {
    console.error('Database error:', dbErr);
    return jsonResponse(
      { error: 'Database error', details: dbErr.message },
      500,
      corsHeaders
    );
  }
}

/**
 * Autocomplete suggestions — returns up to 8 word matches for prefix.
 * GET /api/suggest?q=<prefix>&lang=en|mrh
 */
async function handleSuggest(url, db, corsHeaders) {
  const query = (url.searchParams.get('q') || '').trim();
  const lang  = (url.searchParams.get('lang') || 'en').toLowerCase();

  if (!query || query.length < 1) {
    return jsonResponse({ suggestions: [] }, 200, corsHeaders);
  }

  if (lang !== 'en' && lang !== 'mrh') {
    return jsonResponse({ suggestions: [] }, 200, corsHeaders);
  }

  const col = lang === 'en' ? 'english_word' : 'mara_word';
  const lowerQ = query.toLowerCase();

  try {
    const { results } = await db.prepare(`
      SELECT DISTINCT ${col} AS word
      FROM dictionary
      WHERE LOWER(${col}) LIKE ?1
      ORDER BY
        CASE WHEN LOWER(${col}) = ?2 THEN 0
             WHEN LOWER(${col}) LIKE ?3 THEN 1
             ELSE 2
        END,
        LENGTH(${col}) ASC
      LIMIT 8
    `).bind(`${lowerQ}%`, lowerQ, `${lowerQ}%`).all();

    return jsonResponse(
      { suggestions: results.map(r => r.word) },
      200,
      { ...corsHeaders, 'Cache-Control': 'public, max-age=600' }
    );
  } catch (err) {
    return jsonResponse({ suggestions: [], error: err.message }, 200, corsHeaders);
  }
}

/**
 * Exact word lookup — returns all entries for a specific word (grouped by POS).
 * GET /api/word?q=<word>&lang=en|mrh
 */
async function handleWord(url, db, corsHeaders) {
  const query = (url.searchParams.get('q') || '').trim();
  const lang  = (url.searchParams.get('lang') || 'en').toLowerCase();

  if (!query) {
    return jsonResponse({ error: 'Missing word query' }, 400, corsHeaders);
  }

  if (lang !== 'en' && lang !== 'mrh') {
    return jsonResponse({ error: 'Invalid lang' }, 400, corsHeaders);
  }

  const col = lang === 'en' ? 'english_word' : 'mara_word';
  const lowerQ = query.toLowerCase();

  try {
    // Get exact matches for the word
    const { results } = await db.prepare(`
      SELECT id, english_word, mara_word, part_of_speech, definition, example_sentence
      FROM dictionary
      WHERE LOWER(${col}) = ?1
      ORDER BY
        CASE part_of_speech
          WHEN 'noun' THEN 0
          WHEN 'verb' THEN 1
          WHEN 'adjective' THEN 2
          WHEN 'adverb' THEN 3
          WHEN 'phrase' THEN 4
          WHEN 'interjection' THEN 5
          WHEN 'number' THEN 6
          WHEN 'particle' THEN 7
          ELSE 8
        END
    `).bind(lowerQ).all();

    // Get related words (same first 3 chars, excluding the exact word)
    const prefix = lowerQ.length >= 3 ? lowerQ.substring(0, 3) : lowerQ;
    const { results: related } = await db.prepare(`
      SELECT DISTINCT ${col} AS word
      FROM dictionary
      WHERE LOWER(${col}) LIKE ?1
        AND LOWER(${col}) != ?2
      ORDER BY ${col} ASC
      LIMIT 10
    `).bind(`${prefix}%`, lowerQ).all();

    return jsonResponse(
      {
        query,
        lang,
        count: results.length,
        results,
        related: related.map(r => r.word),
      },
      200,
      { ...corsHeaders, 'Cache-Control': 'public, max-age=300' }
    );
  } catch (err) {
    return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
  }
}

/**
 * Browse words alphabetically.
 * GET /api/browse?letter=A&lang=en|mrh&page=1
 */
async function handleBrowse(url, db, corsHeaders) {
  const letter = (url.searchParams.get('letter') || 'a').trim().toLowerCase();
  const lang   = (url.searchParams.get('lang') || 'en').toLowerCase();
  const page   = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const perPage = 30;
  const offset  = (page - 1) * perPage;

  if (lang !== 'en' && lang !== 'mrh') {
    return jsonResponse({ error: 'Invalid lang' }, 400, corsHeaders);
  }

  const col = lang === 'en' ? 'english_word' : 'mara_word';

  try {
    // Count total for this letter
    const countResult = await db.prepare(`
      SELECT COUNT(DISTINCT ${col}) AS total
      FROM dictionary
      WHERE LOWER(${col}) LIKE ?1
    `).bind(`${letter}%`).first();

    const total = countResult?.total || 0;

    // Get distinct words for this letter
    const { results } = await db.prepare(`
      SELECT DISTINCT ${col} AS word, part_of_speech
      FROM dictionary
      WHERE LOWER(${col}) LIKE ?1
      ORDER BY ${col} ASC
      LIMIT ?2 OFFSET ?3
    `).bind(`${letter}%`, perPage, offset).all();

    return jsonResponse(
      {
        letter,
        lang,
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
        words: results,
      },
      200,
      { ...corsHeaders, 'Cache-Control': 'public, max-age=600' }
    );
  } catch (err) {
    return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
  }
}

/**
 * Dictionary statistics.
 * GET /api/stats
 */
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
    `).first();

    // Get count per part of speech
    const { results: posBreakdown } = await db.prepare(`
      SELECT part_of_speech, COUNT(*) AS count
      FROM dictionary
      WHERE part_of_speech IS NOT NULL
      GROUP BY part_of_speech
      ORDER BY count DESC
    `).all();

    return jsonResponse(
      {
        ...stats,
        parts_of_speech: posBreakdown,
        last_updated: new Date().toISOString(),
      },
      200,
      { ...corsHeaders, 'Cache-Control': 'public, max-age=3600' }
    );
  } catch (err) {
    return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
  }
}

/**
 * Save a dictionary improvement suggestion submitted by users.
 * POST /api/suggestions
 */
async function handleSuggestionSubmit(request, db, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const source_word = String(body.source_word || '').trim();
  const source_lang = String(body.source_lang || '').trim().toLowerCase();
  const english_word = String(body.english_word || '').trim() || null;
  const mara_word = String(body.mara_word || '').trim() || null;
  const suggested_definition = String(body.suggested_definition || '').trim();
  const suggested_example = String(body.suggested_example || '').trim() || null;
  const notes = String(body.notes || '').trim() || null;
  const submitter_name = String(body.submitter_name || '').trim() || null;
  const submitter_email = String(body.submitter_email || '').trim() || null;

  if (!source_word || !suggested_definition) {
    return jsonResponse({ error: 'source_word and suggested_definition are required' }, 400, corsHeaders);
  }

  if (source_lang !== 'en' && source_lang !== 'mrh') {
    return jsonResponse({ error: 'Invalid source_lang. Use "en" or "mrh".' }, 400, corsHeaders);
  }

  if (source_word.length > 120 || suggested_definition.length > 5000) {
    return jsonResponse({ error: 'Input too long' }, 400, corsHeaders);
  }

  if (submitter_email && !/^\S+@\S+\.\S+$/.test(submitter_email)) {
    return jsonResponse({ error: 'Invalid email format' }, 400, corsHeaders);
  }

  try {
    const result = await db.prepare(`
      INSERT INTO suggestions (
        source_word, source_lang, english_word, mara_word,
        suggested_definition, suggested_example, notes,
        submitter_name, submitter_email
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).bind(
      source_word,
      source_lang,
      english_word,
      mara_word,
      suggested_definition,
      suggested_example,
      notes,
      submitter_name,
      submitter_email,
    ).run();

    return jsonResponse({
      success: true,
      id: result.meta.last_row_id,
      message: 'Suggestion submitted successfully',
    }, 201, corsHeaders);
  } catch (err) {
    return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
  }
}

/**
 * ─────────────────────────────────────────────
 * Admin CRUD handler — routes to sub-handlers.
 * All routes require the X-Admin-Key header.
 * ─────────────────────────────────────────────
 */
async function handleAdmin(request, url, env, corsHeaders) {
  const db = env.DB;
  const method = request.method;

  // GET /api/admin/suggestions — list submitted suggestions
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

      const countResult = await db.prepare(
        `SELECT COUNT(*) AS total FROM suggestions ${whereClause}`
      ).bind(...bindings).first();

      const total = countResult?.total || 0;

      const paginationBindings = [...bindings, perPage, offset];
      const limitIndex = bindings.length + 1;
      const { results } = await db.prepare(`
        SELECT id, source_word, source_lang, english_word, mara_word,
               suggested_definition, suggested_example, notes,
               submitter_name, submitter_email, status, created_at
        FROM suggestions
        ${whereClause}
        ORDER BY id DESC
        LIMIT ?${limitIndex} OFFSET ?${limitIndex + 1}
      `).bind(...paginationBindings).all();

      return jsonResponse({
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
        results,
      }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // GET /api/admin/entries — list all entries (paginated + optional filter)
  if (url.pathname === '/api/admin/entries' && method === 'GET') {
    const page    = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '50', 10)));
    const offset  = (page - 1) * perPage;
    const q       = (url.searchParams.get('q') || '').trim();
    const lang    = (url.searchParams.get('lang') || '').toLowerCase();

    try {
      let whereClause = '';
      let bindings = [];

      if (q) {
        const pattern = `%${q.toLowerCase()}%`;
        if (lang === 'mrh') {
          whereClause = 'WHERE LOWER(mara_word) LIKE ?1';
          bindings = [pattern];
        } else {
          whereClause = 'WHERE LOWER(english_word) LIKE ?1 OR LOWER(mara_word) LIKE ?1';
          bindings = [pattern];
        }
      }

      const countResult = await db.prepare(
        `SELECT COUNT(*) AS total FROM dictionary ${whereClause}`
      ).bind(...bindings).first();
      const total = countResult?.total || 0;

      // Append pagination bindings
      const paginationBindings = [...bindings, perPage, offset];
      const limitIndex = bindings.length + 1;
      const { results } = await db.prepare(
        `SELECT id, english_word, mara_word, part_of_speech, definition, example_sentence, created_at
         FROM dictionary
         ${whereClause}
         ORDER BY id DESC
         LIMIT ?${limitIndex} OFFSET ?${limitIndex + 1}`
      ).bind(...paginationBindings).all();

      return jsonResponse({
        page, perPage, total,
        totalPages: Math.ceil(total / perPage),
        results,
      }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // POST /api/admin/entries — create a new entry
  if (url.pathname === '/api/admin/entries' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    const { english_word, mara_word, part_of_speech, definition, example_sentence } = body;
    if (!english_word || !mara_word) {
      return jsonResponse({ error: 'english_word and mara_word are required' }, 400, corsHeaders);
    }

    try {
      const result = await db.prepare(
        `INSERT INTO dictionary (english_word, mara_word, part_of_speech, definition, example_sentence)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(
        english_word.trim(),
        mara_word.trim(),
        part_of_speech?.trim() || null,
        definition?.trim() || null,
        example_sentence?.trim() || null,
      ).run();

      const created = await db.prepare(
        'SELECT * FROM dictionary WHERE id = ?1'
      ).bind(result.meta.last_row_id).first();

      return jsonResponse({ success: true, entry: created }, 201, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // PUT /api/admin/entries/:id — update an entry
  const putMatch = url.pathname.match(/^\/api\/admin\/entries\/(\d+)$/);
  if (putMatch && method === 'PUT') {
    const id = parseInt(putMatch[1], 10);
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    const { english_word, mara_word, part_of_speech, definition, example_sentence } = body;
    if (!english_word || !mara_word) {
      return jsonResponse({ error: 'english_word and mara_word are required' }, 400, corsHeaders);
    }

    try {
      const existing = await db.prepare('SELECT id FROM dictionary WHERE id = ?1').bind(id).first();
      if (!existing) {
        return jsonResponse({ error: 'Entry not found' }, 404, corsHeaders);
      }

      await db.prepare(
        `UPDATE dictionary
         SET english_word = ?1, mara_word = ?2, part_of_speech = ?3,
             definition = ?4, example_sentence = ?5
         WHERE id = ?6`
      ).bind(
        english_word.trim(),
        mara_word.trim(),
        part_of_speech?.trim() || null,
        definition?.trim() || null,
        example_sentence?.trim() || null,
        id,
      ).run();

      const updated = await db.prepare('SELECT * FROM dictionary WHERE id = ?1').bind(id).first();
      return jsonResponse({ success: true, entry: updated }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  // DELETE /api/admin/entries/:id — delete an entry
  const deleteMatch = url.pathname.match(/^\/api\/admin\/entries\/(\d+)$/);
  if (deleteMatch && method === 'DELETE') {
    const id = parseInt(deleteMatch[1], 10);
    try {
      const existing = await db.prepare('SELECT id FROM dictionary WHERE id = ?1').bind(id).first();
      if (!existing) {
        return jsonResponse({ error: 'Entry not found' }, 404, corsHeaders);
      }
      await db.prepare('DELETE FROM dictionary WHERE id = ?1').bind(id).run();
      return jsonResponse({ success: true, deleted_id: id }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: 'Database error', details: err.message }, 500, corsHeaders);
    }
  }

  return jsonResponse({ error: 'Admin route not found' }, 404, corsHeaders);
}

/**
 * Create a JSON response with proper headers.
 */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}
