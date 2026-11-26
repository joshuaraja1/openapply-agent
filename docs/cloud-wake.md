# Cloudflare wake for a private OpenApply agent

This optional single-user control path gives the local OpenApply process a
Cloudflare cron signal every 15 minutes. The Worker stores only a counter and
timestamp in D1. It never receives job history, browser cookies, résumés,
answers, email, or application receipts. The local watcher polls every minute,
then runs the existing `autopilot` command once for each new counter. That
command still owns discovery, matching, PDF creation, provider policy, daily
quota, handoffs, and employer-confirmed submission. If it fails, the counter is
not acknowledged; the next poll retries through its durable checkpoints.

**The local host must stay on.** Cloudflare Workers cannot run this repository's
persistent signed-in Chromium profile and OS secret store. This is not a
hosted, multi-user autonomous service or a public-release gate. An always-on
candidate-controlled computer is the first supported host. A later cloud VM
would need an isolated encrypted volume, a tested Linux Secret Service,
consented browser sign-ins, backup/deletion controls, and an operator.

## Deploy a single-user Worker

1. Sign in to Cloudflare and enable Workers and D1. Copy
   `cloud/wrangler.example.jsonc` to ignored `cloud/wrangler.jsonc`.
2. Run `npx wrangler@4 d1 create openapply-wake`; put its database ID in that
   private config. Run `npx wrangler@4 d1 migrations apply openapply-wake
   --remote --config cloud/wrangler.jsonc`.
3. Generate one random 32-byte token into a temporary owner-only file. Put the
   same token into Cloudflare with `npx wrangler@4 secret put
   OPENAPPLY_AGENT_TOKEN --config cloud/wrangler.jsonc` and into the host's OS
   secret store with `OPENAPPLY_SECRET_REF=keychain://cloud-wake/main
   openapply secret:put` (use `secret-service://` on Linux or
   `credential-manager://` on Windows). Supply the token via stdin; do not
   paste it into a config, argument, issue, or log. Remove the temporary file.
4. Run `npx wrangler@4 deploy --config cloud/wrangler.jsonc`. Record the Worker
   HTTPS URL returned by Wrangler, plus `/v1/tick`.

Cloudflare cron expressions use UTC. The configured 15-minute trigger is a
freshness wake signal, not a claim that every internet job will be found within
15 minutes. Existing source refresh intervals, official-posting checks,
candidate evidence, and provider allowlists still govern applications.

## Connect the local watcher

Create a private mode-0600 JSON file, for example
`~/.openapply-agent/cloud-wake-config.json`:

```json
{
  "version": 1,
  "endpoint": "https://YOUR-WORKER.workers.dev/v1/tick",
  "queueConfigPath": "/ABSOLUTE/PRIVATE/queue-runner.json",
  "tokenReference": "keychain://cloud-wake/main",
  "pollSeconds": 60
}
```

Set `OPENAPPLY_CLOUD_WAKE_CONFIG` to that file and run `openapply cloud:watch
--once` to check one tick, or `openapply cloud:watch` under a user-level process
supervisor for continuous polling. Run one watcher per queue configuration.
The watcher reads its OS-stored token once per process and keeps it in memory
between polls, avoiding repeated Keychain prompts. Restart it after rotating
the token. On macOS, a new or unsigned Node process may still request Keychain
access at startup; do not grant permanent access to every Node script. Use a
signed OpenApply app identity before relying on unattended login-time restart.
The existing workflow lease rejects a concurrent application process. A
failed child exits without advancing the cursor. A missing or backwards
counter, bad token, non-HTTPS endpoint, redirect, or malformed response stops
that poll; it never starts an application.

The cloud wake does **not** enable automatic submission by itself. Each
candidate's private policy and the default-off provider allowlist still apply.
Do not expose a provider until its controlled and consented real-site gates
pass. The Worker must not be described as running a browser or as proof of an
unattended public release.
