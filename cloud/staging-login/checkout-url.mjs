/** Only Stripe test-mode Checkout session URLs may leave this staging page. */
export function stripeTestCheckoutUrl(value) {
  if (typeof value !== 'string') throw new Error('Invalid checkout URL');
  const url = new URL(value);
  const testSession = url.pathname.split('/').some(segment => /^cs_test_[A-Za-z0-9]+$/.test(segment));
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port ||
      url.username || url.password || !testSession) throw new Error('Live or invalid checkout URL');
  return url.href;
}
