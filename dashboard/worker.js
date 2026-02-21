/**
 * Dashboard Proxy Worker
 *
 * Static assets (index.html) are served by [assets].
 * All /api/* requests are proxied to the API worker via a Service Binding
 * so that the CF-Access-Authenticated-User-Email header is preserved
 * (outbound fetch() over the public network strips CF-Access-* headers).
 *
 * Fallback: if the header is not present, we decode the email from the
 * Cf-Access-Jwt-Assertion JWT set by Cloudflare Access.
 */

/**
 * Extracts the authenticated email from the request.
 * Priority: CF-Access-Authenticated-User-Email header > JWT assertion > cookie.
 */
function getEmail(request) {
  // 1. Direct header (set by Cloudflare Access on requests reaching the Worker)
  const hdr = (request.headers.get('CF-Access-Authenticated-User-Email') || '').trim();
  if (hdr) return hdr;

  // 2. Decode from Cf-Access-Jwt-Assertion header (always present behind Access)
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  if (jwt) {
    try {
      const payload = JSON.parse(atob(jwt.split('.')[1]));
      if (payload.email) return payload.email.trim();
    } catch (_) { /* malformed token — ignore */ }
  }

  // 3. Decode from CF_Authorization cookie (belt-and-suspenders)
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/CF_Authorization=([^;]+)/);
  if (match) {
    try {
      const payload = JSON.parse(atob(match[1].split('.')[1]));
      if (payload.email) return payload.email.trim();
    } catch (_) { /* ignore */ }
  }

  return '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Proxy /api/* to the API worker via Service Binding ──
    if (url.pathname.startsWith('/api/')) {
      const email = getEmail(request);

      // Build a clean set of headers for the proxied request
      const proxyHeaders = new Headers();
      proxyHeaders.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
      if (email) {
        proxyHeaders.set('CF-Access-Authenticated-User-Email', email);
      }

      // Construct the URL the API worker expects (its own origin)
      const apiUrl = new URL(url.pathname + url.search, 'https://engmaradictionary.teiteipara.workers.dev');

      const proxyRequest = new Request(apiUrl.toString(), {
        method: request.method,
        headers: proxyHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
      });

      try {
        // Use the Service Binding — direct Worker-to-Worker call, no network hop
        const response = await env.API.fetch(proxyRequest);

        // Re-wrap response so we can add CORS headers for the browser
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', url.origin);
        newHeaders.set('Access-Control-Allow-Credentials', 'true');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Proxy error', details: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Everything else → static assets (index.html)
    return env.ASSETS.fetch(request);
  },
};
