import { createCognitoBrowserAuth } from '/cognito-browser-auth.js';
import { stripeTestCheckoutUrl } from '/checkout-url.mjs';

const status = document.querySelector('#status');
const signIn = document.querySelector('#sign-in');
const signOut = document.querySelector('#sign-out');
const checkoutActions = document.querySelector('#checkout-actions');
const returnPath = location.pathname;
if (returnPath === '/billing/success' || returnPath === '/billing/cancel') {
  history.replaceState(null, '', returnPath); // Drop Stripe session ID before configuration fetch.
}

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
  if (config.checkoutEnabled === true) {
    checkoutActions.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-plan]');
      if (!button) return;
      const token = auth.getIdToken();
      if (!token) { status.textContent = 'Your session expired. Sign in again.'; return; }
      button.disabled = true;
      status.textContent = 'Opening test checkout…';
      try {
        const result = await fetch('/api/billing/checkout', {
          method: 'POST', cache: 'no-store',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: button.dataset.plan }),
        });
        if (!result.ok) throw new Error('Checkout unavailable');
        const payload = await result.json();
        location.assign(stripeTestCheckoutUrl(payload.checkoutUrl));
      } catch {
        status.textContent = 'Test checkout is unavailable. Please try later.';
        button.disabled = false;
      }
    });
  }

  if (location.pathname === '/auth/callback' || location.pathname === '/auth/callback/') {
    const callbackUrl = location.href;
    history.replaceState(null, '', '/auth/callback'); // Remove code before network work.
    try {
      await auth.completeCallback(callbackUrl);
      status.textContent = 'Signed in for this tab. Staging setup is in progress.';
      signOut.hidden = false;
      checkoutActions.hidden = config.checkoutEnabled !== true;
      const token = auth.getIdToken();
      if (token) {
        try {
          const response = await fetch('/api/billing/status', {
            cache: 'no-store', headers: { Authorization: `Bearer ${token}` },
          });
          if (!response.ok) throw new Error('Status unavailable');
          const access = await response.json();
          if (access.active === true && typeof access.accessUntil === 'string') {
            status.textContent = `Signed in. Paid access is active through ${new Date(access.accessUntil).toLocaleDateString()}.`;
          } else if (access.active === false) {
            status.textContent = 'Signed in. No active paid access is recorded yet. A recent test payment may take a minute to process.';
          }
        } catch { status.textContent = 'Signed in. Billing status is temporarily unavailable.'; }
      }
    } catch {
      status.textContent = 'Sign-in failed or expired. Please try again.';
      signIn.hidden = false;
    }
  } else {
    if (returnPath === '/billing/success') {
      status.textContent = 'Stripe returned from test checkout. Sign in to check your verified paid-access status.';
    } else if (returnPath === '/billing/cancel') {
      status.textContent = 'Test checkout was canceled. Sign in to check your current paid-access status.';
    } else {
      status.textContent = 'Sign in to test your OpenApply candidate account.';
    }
    signIn.hidden = false;
  }
} catch {
  status.textContent = 'Sign-in is not configured yet.';
}
