# OpenApply Agent

OpenApply Agent is a privacy-first, human-in-the-loop workflow for discovering fresh jobs, ranking them against evidence-backed candidate facts, tailoring application materials, and preparing guarded browser handoffs.

The scheduled runner can submit supported applications when the user's private
policy authorizes it and records them as submitted only after employer
confirmation. This repository is still a
development project, not a packaged autonomous consumer app. Queued runs depend
on a separately installed BrowserOS neo and a signed-in Overleaf project; some
portals and questions require human completion. See the [production roadmap](docs/production-roadmap.md).
The remaining PR sequence and release gates are in the
[autonomy release requirements](docs/autonomy-release-requirements.md).

It does not include anyone's résumé, address, credentials, application history, or generated documents.

When the repository is opened in a coding-agent workspace, [`AGENTS.md`](AGENTS.md) supplies the end-to-end operating contract: continue from discovery through per-role tailoring, PDF inspection, guarded BrowserOS form filling, explicit submission verification, and private outcome logging.

The default resume layout is the MIT-licensed [Jake Gutierrez LaTeX template](templates/resume/main.tex). New users complete the private Markdown templates; the agent then produces a separate, evidence-backed resume in that layout for every role, compiles it in Overleaf, and downloads the PDF. A person or coding agent must visually inspect every page before upload until automated page-image inspection is implemented. See the [Overleaf workflow](docs/overleaf.md).

## Principles

- Public ATS feeds for discovery; official employer pages for validation.
- Candidate claims require explicit evidence and allowed-use scopes.
- No invented metrics, experience, qualifications, or demographic answers.
- CAPTCHA, MFA, ambiguous compliance questions, and sensitive unknowns stop for a person.
- Final submission is configurable and defaults to human approval.
- Every application attempt is auditable and deduplicated.

## Development

Requires Node.js 22.13 or later. The owned persistent Chromium profile supports
signed-in discovery, Overleaf rendering, and individual applications. BrowserOS
neo is an optional adapter and the established scheduled-queue path. The owned
scheduled-queue preview is tracked in the release PR stack. Public ATS discovery
needs no browser.

```bash
git clone https://github.com/joshuaraja1/openapply-agent.git
cd openapply-agent
npm ci
npm run check
npm run browser:install
npm run browser:doctor
```

## Quick start

1. Run `npm run setup:ui` to edit private user templates in a local browser, or use `npm run setup:init` and edit the Markdown files directly. Complete the structured JSON blocks in files 01–03, then click **Compile profile** or run [`profile:compile`](templates/user/README.md) to create private candidate and preference JSON. See [self-hosting](docs/self-hosting.md) for your own accounts and optional OAuth client ID.
2. Copy the remaining JSON files in `examples/` and replace the examples with private, verified data.
3. Enable official ATS feeds or public career pages in your discovery input.
4. Run the workflow:

```bash
OPENAPPLY_INPUT=/private/discovery-input.json \
OPENAPPLY_CANDIDATE=/private/candidate-profile.json \
OPENAPPLY_PREFERENCES=/private/search-preferences.json \
npm start
```

The output is a ranked local queue containing an evidence-filtered résumé brief and a guarded browser handoff. See [the workflow guide](docs/workflow.md), [architecture](docs/architecture.md), and [safety model](docs/safety.md).

To process that queue sequentially with a restart-safe daily cap, use
[`queue:run` and its setup guide](docs/queue-runner.md). This runner renders a
role-specific PDF in Overleaf, creates a private application package, fills
supported fields, and records the resulting checkpoint.

For a single application, create private render input containing the selected
`job`, its configured official `source`, `candidate`, browser settings,
Overleaf project URL, and a private output directory. Generate the tailored
PDF and application package with:

Use [the synthetic render-input example](examples/render-input.example.json)
for the field structure. Copy a real `job` from the discovery queue, its exact
configured `source`, and your private candidate profile. Use the BrowserOS
endpoint shown by your installation and a dedicated private Overleaf project.
To render with OpenApply's owned Chromium profile, set `"browserRuntime": "owned"`
and remove `browserEndpoint` from the private input. Sign in to Overleaf in that
profile using `npm run browser:open` first. The generated package stays bound
to the owned runtime; `application:run` uses the same profile and rejects a
BrowserOS endpoint for that package. The scheduled queue still uses BrowserOS
until owned application recovery and handoffs pass their release gates.
`expectedConfirmation` must match an employer confirmation after submission;
without it, the runner pauses for a human instead of reporting success.

```bash
OPENAPPLY_RENDER_INPUT=/private/render-input.json npm run resume:render
```

Then run the returned package:

```bash
OPENAPPLY_PACKAGE=/private/application-package.json npm run application:run
```

On macOS or Linux, the runner stores its encryption key in Keychain or Secret
Service respectively, and checkpoints in
`~/.openapply-agent/applications.enc.json`. It fills exact common fields,
stops on unknown required answers, submits only when the handoff mode
authorizes it, and records submission only after a new employer confirmation
is found. Opt-in exact-domain
account creation and scoped email-code entry are available with a private auth
policy and consented mailbox. Provider-specific adapters and automated
page-image inspection are pending; review the
rendered PDF before enabling unattended submission.

When the package stops at final approval, inspect the employer posting and
résumé. To resume that one job after approval, run the same package with
`OPENAPPLY_APPROVE_JOB_ID` set to its exact job ID. The runner re-fetches the
official posting, re-verifies the PDF, and reloads the page before submission.

When BrowserOS pauses for an unknown required field, keep its application tab
open and complete that field yourself. Inspect the encrypted checkpoint with
`OPENAPPLY_JOB_ID=<job-id> npm run application:status`, then resume the package
path it reports with `OPENAPPLY_PACKAGE=<package-path> OPENAPPLY_RESUME_JOB_ID=<job-id> npm run application:run`
after fixing the blocker. For an unknown required answer, provide a private
[`OPENAPPLY_APPROVED_ANSWERS` file](examples/human-answer-approval.example.json)
that names the exact job, tab, field, and value. The runner attaches to the
saved tab and rechecks the official posting and résumé before continuing.
If you manually finish a CAPTCHA or MFA and submit in that tab, use
`OPENAPPLY_PACKAGE=<package-path> OPENAPPLY_CONFIRM_JOB_ID=<job-id> OPENAPPLY_CONFIRMATION_ATTESTATION=<private-attestation-file> npm run application:run`.
It records submission only when the configured employer confirmation is visible
on the approved host and your [attestation](examples/manual-confirmation-attestation.example.json)
names that exact job, tab, and confirmation URL.

## Optional: set up BrowserOS neo

[BrowserOS neo](https://github.com/browseros-ai/BrowserOS) is the local,
open-source browser used for websites that require a real signed-in session.
OpenApply does not receive or store your browser passwords. Install BrowserOS
neo only if you select its browser runtime; the owned profile instructions below
work without a separate BrowserOS installation.

### 1. Install and start BrowserOS neo

On macOS with Homebrew:

```bash
brew tap browseros-ai/tap
brew install --cask browseros-neo
```

Windows and Linux users can install the appropriate package from the
[official BrowserOS neo download page](https://browseros.com/download/).
Launch BrowserOS neo after installation and leave it running while OpenApply
uses browser workflows.

### 2. Import or establish your signed-in sessions

During BrowserOS neo onboarding, import the browser profile you intend to use,
or sign in manually to each required service inside BrowserOS neo. At minimum,
verify the relevant job boards and Overleaf. Employer portals may still require
their own account, MFA, or one-time code. Configure which email each site should
use and whether account creation is allowed in the private authentication policy.
Enter actual passwords through `npm run secret:put` using stdin so they are stored in
the operating-system secret store. Never place account passwords,
session cookies, MFA secrets, or recovery codes in this repository or its JSON
configuration files.

See [authentication and session handling](docs/authentication.md) for profile
import, persistent cookies, account creation, and scoped email-code automation.

### 3. Connect your coding agent

Open a new BrowserOS neo tab, select **MCP** in the sidebar, and use the
one-click **Connect** action for Codex, Cursor, VS Code, or another supported
agent. Restart the agent after connecting. If your agent is not listed, copy
the Streamable HTTP endpoint shown on that MCP page and add it to the agent's
MCP configuration as `browseros-neo`.

The current default endpoint looks like this:

```text
http://127.0.0.1:9200/mcp
```

Always prefer the exact endpoint displayed by your installed BrowserOS neo
version; the port can change. This address is local to your computer and must
not be replaced with a public URL.

### 4. Configure and verify OpenApply

Copy the signed-in search example to a private location, update its `endpoint`
to the value shown in BrowserOS neo, and enable only the searches you want:

```bash
cp examples/browser-searches.json /private/browser-searches.json
```

Keep BrowserOS neo open, then run a small discovery check:

```bash
OPENAPPLY_BROWSER_SEARCH=/private/browser-searches.json \
OPENAPPLY_BROWSER_OUTPUT=/private/browser-leads.json \
npm run browser:discover
```

A successful run writes `browser-leads.json`. If the connection fails:

1. Confirm BrowserOS neo is open and its MCP page reports the agent as connected.
2. Copy the endpoint from that page again; do not assume the example port matches.
3. Restart the coding agent after changing its MCP connection.
4. Confirm the private search file contains valid signed-in URLs and at least one enabled search.
5. Complete CAPTCHA, MFA, one-time-code, or account-recovery prompts manually; OpenApply will not bypass them.

For signed-in discovery on LinkedIn, Jobright, Handshake, or another job board, start BrowserOS neo, copy `examples/browser-searches.json`, enable the searches you want, and run:

```bash
OPENAPPLY_BROWSER_SEARCH=/private/browser-searches.json \
OPENAPPLY_BROWSER_OUTPUT=/private/browser-leads.json \
npm run browser:discover
```

This produces a deduplicated lead queue. It intentionally does not treat aggregator metadata as authoritative; validate each lead against the employer's official posting before tailoring or applying.

### Preview: owned browser for signed-in discovery

The local Chromium profile can collect job links without a separate BrowserOS neo installation. Install its browser binary, then open the profile and sign in manually to the job boards you use:

```bash
npm run browser:install
npm run browser:open
```

Close the browser window or press Ctrl+C in the terminal after signing in. Copy `examples/browser-searches.json` to a private file, set `"runtime": "owned"`, and enable your searches. Then run the `browser:discover` command above with that private file. The profile is stored at `~/.openapply-agent/browser-profile`; only one OpenApply process can use it at a time. Complete CAPTCHA, MFA, and account recovery yourself. Discovery visits only the HTTPS origins of enabled searches and exports listing link labels and URLs to the lead file; it does not export cookies, passwords, or full page text. If a board redirects sign-in to another origin, use `browser:open` to finish sign-in first.

Generic discovery accepts job-looking paths on the configured search origin. Some sites use unusual paths and will need a dedicated source adapter. The owned profile also supports individual application forms and Overleaf rendering; scheduled owned-browser execution and recovery remain release gates.

## Supported discovery sources

- Greenhouse public job-board API
- Ashby public posting API
- Workday public career-site endpoint
- Lever public postings API
- SmartRecruiters public postings API
- Public career pages that expose schema.org `JobPosting` JSON-LD

Authenticated aggregators such as LinkedIn, Jobright, and Handshake require a signed-in browser workflow. They are treated as lead sources: every lead must be validated on an official employer page before application data is prepared or submitted.

More adapters should follow the normalization contract and test requirements in [CONTRIBUTING.md](CONTRIBUTING.md).

## What this project does not do

- It does not bypass CAPTCHA, MFA, rate limits, or access controls.
- It does not invent candidate claims or sensitive answers.
- It does not scrape private LinkedIn data.
- It does not submit by default; final approval is the default policy.

See the repository's merged pull requests for the staged implementation and review rationale.

## License

MIT
