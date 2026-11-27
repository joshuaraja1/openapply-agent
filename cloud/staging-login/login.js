import { createCognitoBrowserAuth } from '/cognito-browser-auth.js';

const status = document.querySelector('#status');
const signIn = document.querySelector('#sign-in');
const signOut = document.querySelector('#sign-out');

try {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Missing staging configuration');
  const config = await response.json();
  const auth = createCognitoBrowserAuth(config, {
    crypto: window.crypto, storage: window.sessionStorage, fetch: window.fetch.bind(window),
  });
  signIn.addEventListener('click', async () => {
    signIn.disabled = true;
    try { location.assign(await auth.beginLogin()); }
    catch { status.textContent = 'Sign-in could not start. Try again.'; signIn.disabled = false; }
  });
  signOut.addEventListener('click', () => location.assign(auth.logout()));

  if (location.pathname === '/auth/callback' || location.pathname === '/auth/callback/') {
    const callbackUrl = location.href;
    history.replaceState(null, '', '/auth/callback'); // Remove code before network work.
    try {
      await auth.completeCallback(callbackUrl);
      status.textContent = 'Signed in for this tab. Staging setup is in progress.';
      signOut.hidden = false;
    } catch {
      status.textContent = 'Sign-in failed or expired. Please try again.';
      signIn.hidden = false;
    }
  } else {
    status.textContent = 'Sign in to test your OpenApply candidate account.';
    signIn.hidden = false;
  }
} catch {
  status.textContent = 'Sign-in is not configured yet.';
}
