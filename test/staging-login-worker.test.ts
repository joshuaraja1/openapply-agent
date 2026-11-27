import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Worker entrypoint is a standalone JavaScript module.
import worker from '../cloud/staging-login/worker.mjs';

function assets() {
  const fetch = vi.fn(async (request: Request) => new Response(new URL(request.url).pathname, {
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'max-age=3600' },
  }));
  return { ASSETS: { fetch } };
}

describe('staging login Worker', () => {
  it('serves exact callback without passing the authorization code to assets', async () => {
    const env = assets();
    const response = await worker.fetch(new Request('https://test.workers.dev/auth/callback?code=secret&state=abc'), env);
    expect(await response.text()).toBe('/auth/callback/index.html');
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
    expect(env.ASSETS.fetch.mock.calls[0]![0].url).toBe('https://test.workers.dev/auth/callback/index.html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('denies API routes until a hosted API is wired', async () => {
    const env = assets();
    const response = await worker.fetch(new Request('https://test.workers.dev/api/billing/checkout',
      { method: 'POST' }), env);
    expect(response.status).toBe(503);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    const onboarding = await worker.fetch(new Request('https://test.workers.dev/api/candidates/onboarding',
      { method: 'POST' }), env);
    expect(onboarding.status).toBe(503);
  });

  it('isolates onboarding, plan and deletion requests to their dedicated API origin', async () => {
    const env = { ...assets(), AWS_API_ORIGIN: 'https://billing.example.com',
      ONBOARDING_API_ORIGIN: 'https://candidate.example.com', CANDIDATE_DELETION_ENABLED: 'true' };
    const upstream = vi.fn(async (_url: URL, _options: RequestInit) =>
      new Response('{"status":"inactive"}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    try {
      for (const path of ['/api/candidates/onboarding', '/api/candidates/plan',
        '/api/candidates/delete']) {
        const response = await worker.fetch(new Request(`https://test.workers.dev${path}`, {
          method: 'POST', headers: { origin: 'https://test.workers.dev',
            authorization: 'Bearer a.b.c', 'content-type': 'application/json' }, body: '{}',
        }), env);
        expect(response.status).toBe(200);
      }
      expect(upstream.mock.calls.map(call => String(call[0]))).toEqual([
        'https://candidate.example.com/api/candidates/onboarding',
        'https://candidate.example.com/api/candidates/plan',
        'https://candidate.example.com/api/candidates/delete',
      ]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps the deletion proxy closed while onboarding is staged', async () => {
    const env = { ...assets(), ONBOARDING_API_ORIGIN: 'https://candidate.example.com' };
    const response = await worker.fetch(new Request('https://test.workers.dev/api/candidates/delete', {
      method: 'POST', headers: { origin: 'https://test.workers.dev',
        authorization: 'Bearer a.b.c', 'content-type': 'application/json' }, body: '{}',
    }), env);
    expect(response.status).toBe(404);
  });

  it('forwards only a bounded authenticated checkout request to configured AWS API', async () => {
    const env = { ...assets(), AWS_API_ORIGIN: 'https://aws-api.example.com' };
    const upstream = vi.fn(async (_url: URL, _options: RequestInit) => new Response('{"checkoutUrl":"https://checkout.stripe.com/test"}',
      { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    try {
      const request = new Request('https://test.workers.dev/api/billing/checkout', {
        method: 'POST', headers: { origin: 'https://test.workers.dev',
          authorization: 'Bearer a.b.c', 'content-type': 'application/json', cookie: 'secret=1' },
        body: '{"plan":"monthly"}',
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const [url, options] = upstream.mock.calls[0]!;
      expect(String(url)).toBe('https://aws-api.example.com/api/billing/checkout');
      expect(options.headers).toMatchObject({ authorization: 'Bearer a.b.c', origin: 'https://test.workers.dev' });
      expect((options.headers as Record<string, string>).cookie).toBeUndefined();
      expect(new TextDecoder().decode(options.body as Uint8Array)).toBe('{"plan":"monthly"}');
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects forged origins, oversized bodies and unexpected API redirects', async () => {
    const env = { ...assets(), AWS_API_ORIGIN: 'https://aws-api.example.com' };
    const validHeaders = { origin: 'https://test.workers.dev',
      authorization: 'Bearer a.b.c', 'content-type': 'application/json' };
    const forge = await worker.fetch(new Request('https://test.workers.dev/api/billing/checkout', {
      method: 'POST', headers: { ...validHeaders, origin: 'https://evil.example' }, body: '{}' }), env);
    expect(forge.status).toBe(403);
    const large = await worker.fetch(new Request('https://test.workers.dev/api/billing/checkout', {
      method: 'POST', headers: validHeaders, body: 'x'.repeat(1025) }), env);
    expect(large.status).toBe(413);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302 })));
    try {
      const redirect = await worker.fetch(new Request('https://test.workers.dev/api/billing/checkout', {
        method: 'POST', headers: validHeaders, body: '{}' }), env);
      expect(redirect.status).toBe(502);
    } finally { vi.unstubAllGlobals(); }
  });
});
