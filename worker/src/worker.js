/**
 * English ⇄ Mara Dictionary — Cloudflare Worker API
 *
 * Endpoints:
 *   GET /api/search?q=<query>&lang=en|mrh    — Dictionary search
 *   GET /api/health                           — Health check
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
