import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

const origin = 'https://staging.example';
const root = resolve('cloud/staging-login');
const authStub = `export function createCognitoBrowserAuth() { return {
  beginLogin: async () => { sessionStorage.setItem('began-login', '1');
    return location.origin + '/auth/callback?code=fixture&state=fixture'; },
  completeCallback: async url => { if (!url.includes('code=fixture')) throw Error('missing code'); },
  getIdToken: () => 'a.b.c', logout: () => location.origin + '/'
}; }`;

describe.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== '1')('staging billing return browser flow', () => {
  for (const returnPath of ['/billing/success', '/billing/cancel']) {
    it(`reauthenticates after ${returnPath} and reads only authenticated status`, async () => {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      const statusRequests: { url: string; authorization: string | undefined }[] = [];
      try {
        await context.route(`${origin}/**`, async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (path === '/billing/success' || path === '/billing/cancel' || path === '/auth/callback') {
            return route.fulfill({ contentType: 'text/html', body: await readFile(resolve(root, 'index.html'), 'utf8') });
          }
          if (path === '/login.js') return route.fulfill({ contentType: 'text/javascript',
            body: await readFile(resolve(root, 'login.js'), 'utf8') });
          if (path === '/cognito-browser-auth.js') return route.fulfill({ contentType: 'text/javascript', body: authStub });
          if (path === '/checkout-url.mjs') return route.fulfill({ contentType: 'text/javascript',
            body: 'export const stripeTestCheckoutUrl = url => url;' });
          if (path === '/config.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            issuer: 'https://auth.example', clientId: 'fixture', loginDomain: 'https://auth.example',
            appOrigin: origin, checkoutEnabled: true,
          }) });
          if (path === '/api/billing/status') {
            statusRequests.push({ url: request.url(), authorization: request.headers().authorization });
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
              active: true, accessUntil: '2098-01-01T00:00:00.000Z', plan: 'subscription',
            }) });
          }
          return route.fulfill({ status: 404, body: '' });
        });
        await page.goto(`${origin}${returnPath}?session_id=cs_test_fixture`);
        await expect.poll(() => page.locator('#status').textContent()).toContain('Paid access is active');
        expect(page.url()).toBe(`${origin}/auth/callback`);
        expect(statusRequests).toEqual([{ url: `${origin}/api/billing/status`, authorization: 'Bearer a.b.c' }]);
        expect(await page.evaluate(() => sessionStorage.getItem('began-login'))).toBe('1');
        expect(await page.evaluate(() => sessionStorage.getItem('openapply.billing.return.v1'))).toBeNull();
      } finally { await context.close(); await browser.close(); }
    });
  }
});
