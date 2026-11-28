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
      const onboarding = url.pathname === '/api/candidates/onboarding';
      const plan = url.pathname === '/api/candidates/plan';
      const deletion = url.pathname === '/api/candidates/delete'
        || url.pathname === '/api/candidates/deletion-status';
      const runCreation = url.pathname === '/api/applications/runs';
      const reviewedRetry = url.pathname === '/api/applications/reviewed-retry';
      const enqueue = url.pathname === '/api/applications/enqueue';
      const jobs = url.pathname === '/api/jobs/matches';
      if (jobs && env.JOB_DISCOVERY_ENABLED !== 'true') {
        return new Response('Not found', { status: 404, headers: securityHeaders });
      }
      if (deletion && env.CANDIDATE_DELETION_ENABLED !== 'true') {
        return new Response('Not found', { status: 404, headers: securityHeaders });
      }
      if ((runCreation && env.APPLICATION_RUN_CREATION_ENABLED !== 'true')
        || (reviewedRetry && env.APPLICATION_REVIEWED_RETRY_ENABLED !== 'true')
        || (enqueue && env.APPLICATION_ENQUEUE_ENABLED !== 'true')) {
        return new Response('Not found', { status: 404, headers: securityHeaders });
      }
      if ((!onboarding && !plan && !deletion && !runCreation && !reviewedRetry && !enqueue && !jobs
        && url.pathname !== '/api/billing/checkout') || request.method !== (jobs ? 'GET' : 'POST')) {
        return new Response('Not found', { status: 404, headers: securityHeaders });
      }
      const apiOrigin = onboarding || plan || deletion || jobs ? env.ONBOARDING_API_ORIGIN : env.AWS_API_ORIGIN;
      if (!apiOrigin) {
        return new Response('API not configured', { status: 503, headers: securityHeaders });
      }
      if (!(request.headers.get('origin') === url.origin
          || (jobs && !request.headers.has('origin')
            && request.headers.get('sec-fetch-site') === 'same-origin')) ||
          !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(request.headers.get('authorization') ?? '') ||
          (!jobs && !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''))) {
        return new Response('Invalid request', { status: 403, headers: securityHeaders });
      }
      if (jobs && ([...url.searchParams.keys()].some(key => key !== 'page')
        || url.searchParams.getAll('page').length > 1
        || !/^[0-9]$/.test(url.searchParams.get('page') ?? '0'))) {
        return new Response('Invalid page', { status: 400, headers: securityHeaders });
      }
      let upstream;
      try {
        upstream = new URL(apiOrigin);
        if (upstream.protocol !== 'https:' || upstream.username || upstream.password ||
            upstream.search || upstream.hash || upstream.pathname !== '/') throw new Error('Invalid upstream');
      } catch { return new Response('API not configured', { status: 503, headers: securityHeaders }); }
      const reader = jobs ? undefined : request.body?.getReader();
      if (!jobs && !reader) return new Response('Invalid request', { status: 400, headers: securityHeaders });
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          if (!reader) break;
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > (onboarding ? 7_500_000 : runCreation ? 2048 : 1024)) {
            await reader.cancel();
            return new Response('Request too large', { status: 413, headers: securityHeaders });
          }
          chunks.push(value);
        }
      } finally { reader?.releaseLock(); }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      upstream.pathname = url.pathname;
      if (jobs) upstream.search = url.search;
      try {
        const response = await fetch(upstream, {
          method: jobs ? 'GET' : 'POST', ...(jobs ? {} : { body }), redirect: 'manual',
          signal: AbortSignal.timeout(onboarding ? 60_000 : deletion ? 65_000 : 10_000),
          headers: {
            'authorization': request.headers.get('authorization'),
            ...(jobs ? {} : { 'content-type': request.headers.get('content-type') }),
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
    // Never forward the OAuth authorization code to the asset lookup/log path.
    url.search = '';
    url.hash = '';
    const asset = await env.ASSETS.fetch(new Request(url, { method: request.method }));
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
    return new Response(asset.body, { status: asset.status, headers });
  },
};
