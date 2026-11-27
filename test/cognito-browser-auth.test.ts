import { describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { createCognitoBrowserAuth } from '../src/hosted/cognito-browser-auth.js';

const config = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
  clientId: 'public-client',
  loginDomain: 'https://openapply-staging.auth.us-east-1.amazoncognito.com',
  appOrigin: 'https://openapplyagent.xyz',
};
const callback = 'https://openapplyagent.xyz/auth/callback';

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const clock = 1_800_000_000_000;
  const fetcher = vi.fn<typeof fetch>();
  const auth = createCognitoBrowserAuth(config, { crypto: webcrypto as Crypto, storage, fetch: fetcher, now: () => clock });
  const jwt = (nonce: string) => {
    const claims = { iss: config.issuer, aud: config.clientId, nonce, token_use: 'id', sub: 'user-123', exp: clock / 1000 + 3600 };
    return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  };
  return { auth, values, fetcher, clock, jwt };
}

describe('Cognito browser auth', () => {
  it('creates random one-time state, nonce, and S256 PKCE challenge', async () => {
    const { auth, values } = fixture();
    const first = new URL(await auth.beginLogin());
    const pending = JSON.parse([...values.values()][0]!);
    expect(first.pathname).toBe('/oauth2/authorize');
    expect(first.searchParams.get('response_type')).toBe('code');
    expect(first.searchParams.get('redirect_uri')).toBe(callback);
    expect(first.searchParams.get('state')).toBe(pending.state);
    expect(first.searchParams.get('nonce')).toBe(pending.nonce);
    expect(first.searchParams.get('code_challenge_method')).toBe('S256');
    expect(first.searchParams.get('code_challenge')).toBe(createHash('sha256').update(pending.verifier).digest('base64url'));
    const second = new URL(await auth.beginLogin());
    expect(second.searchParams.get('state')).not.toBe(first.searchParams.get('state'));
  });

  it('exchanges a matching callback once and holds the ID token in memory only', async () => {
    const { auth, values, fetcher, jwt } = fixture();
    const login = new URL(await auth.beginLogin());
    const pending = JSON.parse([...values.values()][0]!);
    const token = jwt(pending.nonce);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ id_token: token, token_type: 'Bearer', refresh_token: 'secret' }), { status: 200 }));
    await auth.completeCallback(`${callback}?code=abc&state=${login.searchParams.get('state')}`);
    expect(auth.getIdToken()).toBe(token);
    expect(values.size).toBe(0);
    const request = fetcher.mock.calls[0]!;
    expect(String(request[0])).toBe(`${config.loginDomain}/oauth2/token`);
    expect(String(request[1]?.body)).toContain(`code_verifier=${pending.verifier}`);
    await expect(auth.completeCallback(`${callback}?code=abc&state=${pending.state}`)).rejects.toThrow('expired');
  });

  it('rejects state mismatch, wrong origin, duplicate state, and stale callbacks', async () => {
    const { auth, values, fetcher, clock } = fixture();
    const login = new URL(await auth.beginLogin());
    const state = login.searchParams.get('state');
    await expect(auth.completeCallback(`https://evil.example/auth/callback?code=abc&state=${state}`)).rejects.toThrow();
    await expect(auth.completeCallback(`${callback}?code=abc&state=forged`)).rejects.toThrow('state mismatch');
    expect(fetcher).not.toHaveBeenCalled();
    await auth.beginLogin();
    const pending = JSON.parse([...values.values()][0]!);
    await expect(auth.completeCallback(`${callback}?code=abc&state=${pending.state}&state=${pending.state}`)).rejects.toThrow('state mismatch');
    await auth.beginLogin();
    const old = JSON.parse([...values.values()][0]!);
    old.createdAt = clock - 6 * 60_000;
    values.set([...values.keys()][0]!, JSON.stringify(old));
    await expect(auth.completeCallback(`${callback}?code=abc&state=${old.state}`)).rejects.toThrow('state mismatch');
  });

  it('rejects a nonce mismatch and clears state before a failed exchange', async () => {
    const { auth, values, fetcher, jwt } = fixture();
    const login = new URL(await auth.beginLogin());
    fetcher.mockResolvedValue(new Response(JSON.stringify({ id_token: jwt('wrong'), token_type: 'Bearer' }), { status: 200 }));
    await expect(auth.completeCallback(`${callback}?code=abc&state=${login.searchParams.get('state')}`)).rejects.toThrow('claims');
    expect(values.size).toBe(0);
    expect(auth.getIdToken()).toBeUndefined();
  });

  it('logs out without putting a token in the URL or storage', async () => {
    const { auth, values } = fixture();
    await auth.beginLogin();
    const logout = new URL(auth.logout());
    expect(logout.pathname).toBe('/logout');
    expect(logout.searchParams.get('logout_uri')).toBe(`${config.appOrigin}/`);
    expect(logout.searchParams.has('id_token_hint')).toBe(false);
    expect(values.size).toBe(0);
    expect(auth.getIdToken()).toBeUndefined();
  });
});
