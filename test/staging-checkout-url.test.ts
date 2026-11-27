import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone browser JavaScript module.
import { stripeTestCheckoutUrl } from '../cloud/staging-login/checkout-url.mjs';

describe('staging checkout navigation', () => {
  it('accepts only an HTTPS Stripe test Checkout session', () => {
    expect(stripeTestCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test_123ABC'))
      .toBe('https://checkout.stripe.com/c/pay/cs_test_123ABC');
  });
  it('blocks live sessions, lookalike hosts and URLs with userinfo', () => {
    for (const url of [
      'https://checkout.stripe.com/c/pay/cs_live_123ABC',
      'https://checkout.stripe.com.evil.example/c/pay/cs_test_123ABC',
      'https://user@checkout.stripe.com/c/pay/cs_test_123ABC',
      'http://checkout.stripe.com/c/pay/cs_test_123ABC',
      'https://checkout.stripe.com/c/pay/not-a-session',
    ]) expect(() => stripeTestCheckoutUrl(url)).toThrow();
  });
});
