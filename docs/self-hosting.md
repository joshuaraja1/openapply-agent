# Self-hosting with your own accounts

OpenApply runs locally. It has no shared OpenApply API key or hosted account.
The deterministic discovery, matching, and résumé code needs no LLM API key.
Each user supplies their own candidate facts, search preferences, browser
sessions, Overleaf project, and any employer-portal credentials they choose to
store. Mailbox verification is optional and requires that user's Google or
Microsoft desktop OAuth client ID and consent. Passwords and OAuth tokens go
to the operating-system secret store, never to this repository or JSON files.

## First run

1. Install Node 22.13+ and run `npm ci`, `npm run browser:install`, and
   `npm run browser:doctor` from the repository root.
2. Run `npm run setup:ui` and open the local URL it prints. The editor creates
   private copies of templates 01–08 in `~/.openapply-agent/onboarding`, saves
   with conflict detection, and preserves completed answers. `npm run setup:init`
   remains available for users who prefer editing the files directly.
3. Complete the structured blocks in templates 01–03, then run
   [`profile:compile`](../templates/user/README.md) with paths to those private
   files. Each usable matching skill needs an approved work-history claim.
4. Configure your own target roles, official source list, daily cap, Overleaf
   project, and browser-search URLs. Sign in through your dedicated local
   browser profile. A company portal may require its own account.
5. If using automatic site login, create a private authentication policy with
   exact domains and OS secret references. Enter each password through
   `npm run secret:put` using stdin. If enabling email-code entry, register your
   own OAuth desktop client, add its client ID to the policy, and run the
   consent flow. Do not put passwords or client secrets in environment variables.
6. Run discovery and a prepare-only application first. Enable automatic final
   submission only after reviewing the candidate's policy and testing the
   target portals.

The scheduled queue's established path uses BrowserOS neo. An owned-browser
queue preview is tracked in the release PR stack; recovery from human handoffs
still needs validation. The local setup editor covers private templates; account
consent, source configuration, dry-run preview, and installation are still CLI
steps. OpenApply cannot promise
every job on the internet or bypass CAPTCHA, MFA, legal questions, or site
access controls. See the [release requirements](autonomy-release-requirements.md)
for the remaining public-product gates.
