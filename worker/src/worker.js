/**
 * English ⇄ Mara Dictionary — Cloudflare Worker API
 *
 * Endpoints:
 *   GET /api/search?q=<query>&lang=en|mrh          — Dictionary search
 *   GET /api/suggest?q=<prefix>&lang=en|mrh         — Autocomplete suggestions
 *   GET /api/word?q=<word>&lang=en|mrh              — Exact word lookup (definition page)
 *   GET /api/browse?letter=<A-Z>&lang=en|mrh&page=1 — Browse words alphabetically
 *   GET /api/stats                                  — Dictionary statistics
 *   GET /api/health                                 — Health check
 *
 * Binds to a Cloudflare D1 database named DB.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Only allow GET and HEAD
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
