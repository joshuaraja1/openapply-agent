const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https://*.amazoncognito.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const checkout = url.pathname === '/api/billing/checkout' && request.method === 'POST';
      const status = url.pathname === '/api/billing/status' && request.method === 'GET';
      if (!checkout && !status) {
        return new Response('Not found', { status: 404, headers: securityHeaders });
      }
      if (!env.AWS_API_ORIGIN) {
        return new Response('API not configured', { status: 503, headers: securityHeaders });
      }
      if ((checkout ? request.headers.get('origin') !== url.origin
        : request.headers.get('sec-fetch-site') !== 'same-origin') ||
          !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(request.headers.get('authorization') ?? '') ||
          (checkout && !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''))) {
        return new Response('Invalid request', { status: 403, headers: securityHeaders });
      }
      if (status && url.search) return new Response('Invalid request', { status: 400, headers: securityHeaders });
      let upstream;
      try {
        upstream = new URL(env.AWS_API_ORIGIN);
        if (upstream.protocol !== 'https:' || upstream.username || upstream.password ||
            upstream.search || upstream.hash || upstream.pathname !== '/') throw new Error('Invalid upstream');
      } catch { return new Response('API not configured', { status: 503, headers: securityHeaders }); }
      let body;
      if (checkout) {
        const reader = request.body?.getReader();
        if (!reader) return new Response('Invalid request', { status: 400, headers: securityHeaders });
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1024) {
              await reader.cancel();
              return new Response('Request too large', { status: 413, headers: securityHeaders });
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      }
      upstream.pathname = url.pathname;
      try {
        const response = await fetch(upstream, {
          method: request.method, ...(checkout ? { body } : {}),
          redirect: 'manual', signal: AbortSignal.timeout(10_000),
          headers: {
            'authorization': request.headers.get('authorization'),
            ...(checkout ? { 'content-type': request.headers.get('content-type') } : {}),
            'origin': url.origin,
          },
        });
        if (response.status >= 300 && response.status < 400) {
          return new Response('Unexpected API redirect', { status: 502, headers: securityHeaders });
        }
        const headers = new Headers(securityHeaders);
        headers.set('Content-Type', 'application/json; charset=utf-8');
        return new Response(response.body, { status: response.status, headers });
      } catch { return new Response('API unavailable', { status: 503, headers: securityHeaders }); }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: securityHeaders });
    }
    if (url.pathname === '/auth/callback' || url.pathname === '/auth/callback/') {
      url.pathname = '/auth/callback/index.html';
    }
    if (url.pathname === '/billing/success' || url.pathname === '/billing/cancel') {
      url.pathname = '/index.html';
    }
    // Never forward the OAuth authorization code to the asset lookup/log path.
    url.search = '';
    url.hash = '';
    const asset = await env.ASSETS.fetch(new Request(url, { method: request.method }));
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
    return new Response(asset.body, { status: asset.status, headers });
  },
};
