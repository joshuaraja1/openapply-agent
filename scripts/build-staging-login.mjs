import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('cloud/staging-login');
const target = resolve('cloud/staging-login-dist');
await mkdir(resolve(target, 'auth/callback'), { recursive: true });
for (const file of ['index.html', 'style.css', 'login.js', 'onboarding.js', 'deletion.js', 'jobs.js', 'checkout-url.mjs', '_headers', '_redirects']) {
  await copyFile(resolve(source, file), resolve(target, file));
}
await copyFile(resolve(source, 'index.html'), resolve(target, 'auth/callback/index.html'));
await copyFile(resolve('dist/src/hosted/cognito-browser-auth.js'), resolve(target, 'cognito-browser-auth.js'));

const issuer = process.env.OPENAPPLY_COGNITO_ISSUER;
const clientId = process.env.OPENAPPLY_COGNITO_CLIENT_ID;
const loginDomain = process.env.OPENAPPLY_COGNITO_LOGIN_DOMAIN;
const appOrigin = process.env.OPENAPPLY_STAGING_ORIGIN ?? 'https://staging.openapplyagent.xyz';
const configured = issuer && clientId && loginDomain;
await writeFile(resolve(target, 'config.json'), JSON.stringify(configured
  ? { issuer, clientId, loginDomain, appOrigin,
    checkoutEnabled: process.env.OPENAPPLY_STAGING_CHECKOUT_ENABLED === 'true',
    onboardingEnabled: process.env.OPENAPPLY_STAGING_ONBOARDING_ENABLED === 'true',
    deletionEnabled: process.env.OPENAPPLY_STAGING_DELETION_ENABLED === 'true',
    jobDiscoveryEnabled: process.env.OPENAPPLY_STAGING_JOB_DISCOVERY_ENABLED === 'true' }
  : { issuer: '', clientId: '', loginDomain: '', appOrigin, checkoutEnabled: false, onboardingEnabled: false, deletionEnabled: false, jobDiscoveryEnabled: false }) + '\n');
console.log(`Built staging login site (${configured ? 'configured' : 'setup pending'}).`);
