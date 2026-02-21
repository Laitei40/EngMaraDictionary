/**
 * Dashboard Proxy Worker
 *
 * Static assets (index.html) are served by [assets].
 * All /api/* requests are proxied to the API worker with the
 * CF-Access-Authenticated-User-Email header forwarded, so the
 * API worker can authenticate the Cloudflare Access identity.
 */

const API_ORIGIN = 'https://engmaradictionary.teiteipara.workers.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Proxy /api/* to the API worker
    if (url.pathname.startsWith('/api/')) {
      const email = request.headers.get('CF-Access-Authenticated-User-Email') || '';

      const apiUrl = `${API_ORIGIN}${url.pathname}${url.search}`;

      const proxyHeaders = new Headers(request.headers);
      // Ensure the identity header is forwarded
      if (email) {
        proxyHeaders.set('CF-Access-Authenticated-User-Email', email);
      }
      // Remove host header so it matches the API origin
      proxyHeaders.delete('host');

      const proxyRequest = new Request(apiUrl, {
        method: request.method,
        headers: proxyHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
      });

      try {
        const response = await fetch(proxyRequest);

        // Clone response and add CORS headers for same-origin (belt and suspenders)
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

    // Everything else falls through to [assets] (index.html)
    return env.ASSETS.fetch(request);
  },
};
