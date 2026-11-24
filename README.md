# OpenApply Agent

OpenApply Agent is a privacy-first, human-in-the-loop workflow for discovering fresh jobs, ranking them against evidence-backed candidate facts, tailoring application materials, and preparing guarded browser handoffs.

It does not include anyone's résumé, address, credentials, application history, or generated documents.

When the repository is opened in a coding-agent workspace, [`AGENTS.md`](AGENTS.md) supplies the end-to-end operating contract: continue from discovery through per-role tailoring, PDF inspection, guarded BrowserOS form filling, explicit submission verification, and private outcome logging.

The default resume layout is the MIT-licensed [Jake Gutierrez LaTeX template](templates/resume/main.tex). New users complete the private Markdown templates; the agent then produces a separate, evidence-backed resume in that layout for every role, compiles it in Overleaf, downloads the PDF, and visually verifies it before upload. See the [Overleaf workflow](docs/overleaf.md).

## Principles

- Public ATS feeds for discovery; official employer pages for validation.
- Candidate claims require explicit evidence and allowed-use scopes.
- No invented metrics, experience, qualifications, or demographic answers.
- CAPTCHA, MFA, ambiguous compliance questions, and sensitive unknowns stop for a person.
- Final submission is configurable and defaults to human approval.
- Every application attempt is auditable and deduplicated.

## Development

Requires Node.js 22.13 or later. BrowserOS neo supports signed-in job-board
discovery and the current Overleaf workflow. The guarded application runner uses
its own persistent local Chromium profile; public ATS discovery needs neither
browser.

```bash
git clone https://github.com/joshuaraja1/openapply-agent.git
cd openapply-agent
npm ci
npm run check
```

## Quick start

1. Copy `templates/user/` to a private directory and complete the Markdown files, including the authentication and browser-profile policy.
2. Copy the JSON files in `examples/` and replace the examples with private, verified data.
3. Enable official ATS feeds or public career pages in your discovery input.
4. Run the workflow:

```bash
OPENAPPLY_INPUT=/private/discovery-input.json \
OPENAPPLY_CANDIDATE=/private/candidate-profile.json \
OPENAPPLY_PREFERENCES=/private/search-preferences.json \
npm start
```

The output is a ranked local queue containing an evidence-filtered résumé brief and a guarded browser handoff. See [the workflow guide](docs/workflow.md), [architecture](docs/architecture.md), and [safety model](docs/safety.md).

For a single application with a verified role-specific PDF, create a private
application package containing the `job`, `candidate`, `handoff`,
`resumeSource`, `resumePdfPath`, and optional `expectedConfirmation`. Then run:

```bash
OPENAPPLY_PACKAGE=/private/application-package.json npm run application:run
```

On macOS, the runner stores its encryption key in Keychain and checkpoints in
`~/.openapply-agent/applications.enc.json`. It fills exact common fields,
stops on unknown required answers, and submits only when the handoff mode
authorizes it and a new employer confirmation is found. Account creation,
email-code retrieval, provider-specific multi-page forms, and automatic
Overleaf PDF compilation are still in development.

## Set up BrowserOS neo

[BrowserOS neo](https://github.com/browseros-ai/BrowserOS) is the local,
open-source browser used for websites that require a real signed-in session.
OpenApply does not receive or store your browser passwords. BrowserOS neo must
be installed, running, and connected before OpenApply can use LinkedIn,
Jobright, Handshake, Overleaf, or an employer's application portal.

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
Enter actual passwords only through the local onboarding UI so they are stored in
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
