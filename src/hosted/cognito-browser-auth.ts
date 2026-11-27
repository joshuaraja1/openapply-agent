/** Browser-side Cognito sign-in for the public, PKCE-enabled staging client. */
export type CognitoBrowserConfig = {
  issuer: string;
  clientId: string;
  loginDomain: string;
  appOrigin: string;
};

type PendingLogin = { state: string; nonce: string; verifier: string; createdAt: number };
type BrowserDeps = {
  crypto: Crypto;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  fetch: typeof fetch;
  now?: () => number;
};

const STORAGE_KEY = 'openapply.cognito.pending.v1';
const FIVE_MINUTES = 5 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function randomString(crypto: Crypto): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function tokenClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part || part.length > 16_384) throw new Error('Invalid identity token');
  try {
    const bytes = atob(part.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - part.length % 4) % 4));
    const parsed: unknown = JSON.parse(bytes);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid identity token');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('Invalid identity token');
  }
}

function validatedConfig(config: CognitoBrowserConfig): { issuer: string; login: URL; origin: string; callback: string } {
  const issuer = new URL(config.issuer);
  const login = new URL(config.loginDomain);
  const origin = new URL(config.appOrigin);
  if (issuer.protocol !== 'https:' || login.protocol !== 'https:' || origin.protocol !== 'https:' ||
      issuer.username || login.username || origin.username || issuer.search || login.search || origin.search ||
      issuer.hash || login.hash || origin.hash || login.pathname !== '/' || origin.pathname !== '/' ||
      login.port || origin.port || !config.clientId ||
      !/^[a-z0-9.-]+\.amazoncognito\.com$/.test(login.hostname)) {
    throw new Error('Invalid Cognito browser configuration');
  }
  return { issuer: issuer.href.replace(/\/$/, ''), login, origin: origin.origin, callback: `${origin.origin}/auth/callback` };
}

/**
 * Tokens are intentionally held only in this controller's memory. A reload requires
 * sign-in again; Cognito's own hosted session can make that quick. The server must
 * independently verify every ID token signature and claim before granting access.
 */
export function createCognitoBrowserAuth(config: CognitoBrowserConfig, deps: BrowserDeps) {
  const { issuer, login, origin, callback } = validatedConfig(config);
  const now = deps.now ?? Date.now;
  let idToken: string | undefined;
  let expiry = 0;

  return {
    async beginLogin(): Promise<string> {
      idToken = undefined;
      expiry = 0;
      const pending: PendingLogin = {
        state: randomString(deps.crypto),
        nonce: randomString(deps.crypto),
        verifier: randomString(deps.crypto),
        createdAt: now(),
      };
      deps.storage.setItem(STORAGE_KEY, JSON.stringify(pending));
      const challenge = base64url(new Uint8Array(await deps.crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier))));
      const url = new URL('/oauth2/authorize', login);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: config.clientId, redirect_uri: callback,
        scope: 'openid email profile', code_challenge_method: 'S256', code_challenge: challenge,
        state: pending.state, nonce: pending.nonce,
      }).toString();
      return url.href;
    },
    async completeCallback(callbackUrl: string): Promise<void> {
      const url = new URL(callbackUrl);
      if (url.origin !== origin || url.pathname !== '/auth/callback' || url.hash || url.searchParams.has('error')) {
        throw new Error('Invalid sign-in callback');
      }
      const serialized = deps.storage.getItem(STORAGE_KEY);
      deps.storage.removeItem(STORAGE_KEY); // One use, including failed code exchanges.
      let pending: PendingLogin;
      try { pending = JSON.parse(serialized ?? '') as PendingLogin; }
      catch { throw new Error('Sign-in session expired'); }
      const state = url.searchParams.getAll('state');
      const code = url.searchParams.getAll('code');
      if (state.length !== 1 || code.length !== 1 || !code[0] || state[0] !== pending.state ||
          typeof pending.verifier !== 'string' || typeof pending.nonce !== 'string' ||
          !Number.isFinite(pending.createdAt) || now() - pending.createdAt > FIVE_MINUTES ||
          now() < pending.createdAt) throw new Error('Sign-in state mismatch');
      const endpoint = new URL('/oauth2/token', login);
      const response = await deps.fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId,
          code: code[0], redirect_uri: callback, code_verifier: pending.verifier }),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Sign-in code exchange failed');
      const body = await response.json() as { id_token?: unknown; token_type?: unknown };
      if (typeof body.id_token !== 'string' || body.token_type !== 'Bearer') throw new Error('Invalid sign-in response');
      const claims = tokenClaims(body.id_token);
      if (claims.iss !== issuer || claims.aud !== config.clientId || claims.nonce !== pending.nonce ||
          claims.token_use !== 'id' || typeof claims.exp !== 'number' || claims.exp * 1000 <= now() ||
          typeof claims.sub !== 'string' || !claims.sub) throw new Error('Invalid identity token claims');
      // Claim checks here protect the browser flow. The API verifies the JWT signature via JWKS.
      idToken = body.id_token;
      expiry = claims.exp * 1000;
    },
    getIdToken(): string | undefined {
      if (now() >= expiry - 30_000) { idToken = undefined; return undefined; }
      return idToken;
    },
    logout(): string {
      idToken = undefined;
      expiry = 0;
      deps.storage.removeItem(STORAGE_KEY);
      const url = new URL('/logout', login);
      url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: `${origin}/` }).toString();
      return url.href;
    },
  };
}
