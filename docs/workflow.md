# End-to-end workflow

## 1. Prepare private inputs

Copy `templates/user/` outside the repository, complete every relevant placeholder, and convert the approved facts into a private candidate JSON file matching `candidateProfileSchema`.
Automatic matching requires at least one skill shared by the job and an
approved work-history claim. A skills inventory entry without an evidenced
claim does not make a role eligible for unattended application.

## 2. Configure sources

Copy the files in `examples/`, enable official ATS sources, and set include and exclude keywords. Public adapters cover Greenhouse, Ashby, Workday, Lever, SmartRecruiters, and career pages with schema.org `JobPosting` data.

For LinkedIn, Jobright, Handshake, or another authenticated board, start BrowserOS neo and configure a private copy of `examples/browser-searches.json`. The browser connector uses the signed-in profile and writes discovered links to a local lead queue:

```bash
OPENAPPLY_BROWSER_SEARCH=/private/browser-searches.json \
OPENAPPLY_BROWSER_OUTPUT=/private/browser-leads.json \
npm run browser:discover
```

Aggregator results are leads, not verified jobs. Open the employer's official posting, confirm the role is active, and add its official ATS or JSON-LD source before an application is prepared.

## 3. Discover and rank

```bash
OPENAPPLY_INPUT=/private/discovery-input.json \
OPENAPPLY_CANDIDATE=/private/candidate-profile.json \
OPENAPPLY_PREFERENCES=/private/search-preferences.json \
npm start
```

The queue puts roles with a verified posting time within the preferred window
first. Newly observed roles without a posting date follow, then older active
roles backfill the remaining capacity. The example has no age cutoff; set
`maximumFreshnessHours` to a number if the candidate wants one. First-seen
time is never described as a verified posting time. The daily cap and
deduplication still apply.

Each scheduled discovery refreshes pending jobs against the current official
source response and ranks the whole queue again. A job that disappeared from
a successfully refreshed official source is removed from that run's queue. A
source outage retains its pending jobs with `sourceVerification: unavailable`;
the runner skips them until a later successful fetch verifies them again. A
dropped job is also retained as unavailable when the configured per-source limit
truncates the official response, because its absence cannot prove closure. A
dropped queue entry remains eligible for rediscovery if it reappears. The encrypted application checkpoint
still prevents a confirmed submission from being repeated. Discovery keeps all
eligible active jobs in the ranked queue; the application runner enforces the
daily cap after skipping jobs with terminal or waiting checkpoints, so those
jobs cannot consume every queue slot ahead of usable backfill.
SmartRecruiters discovery follows the public posting API's offset pagination
and fetches each posting's detail; an incomplete page or failed detail fetch
pauses that source instead of treating omitted jobs as closed.
Workday discovery also follows offset pages. A repeated posting or an early
empty page fails the source so pending applications pause safely.
Relative Workday posting labels retain a conservative age bound. They are not
reported as exact posting timestamps; older labels cannot enter the recent tier.
If the queue file is lost, discovery can reconstruct it from current official
postings: `reportedAt` means queued, while encrypted application checkpoints
prevent a completed or uncertain submission from being repeated.

## 4. Tailor and verify

For each queue item:

1. Re-open the official job posting and confirm it is active.
2. Use the generated tailoring brief and the user's completed Markdown templates with the default [Jake Gutierrez LaTeX template](../templates/resume/main.tex), unless the user explicitly selected another approved template.
3. Copy the role-specific `main.tex` into the private Overleaf project, compile and download the PDF, then render every page to an image.
4. Check clipping, spacing, page count, selectable text, chronology, and claim evidence.

Replace placeholders only in a private working copy or private Overleaf project; never commit completed résumés. Follow the complete [Overleaf workflow](overleaf.md).

## 5. Browser handoff

The queue contains the only allowed application domain and mandatory stop conditions. A browser worker may prepare supported fields. It must stop for CAPTCHA, MFA, unknown sensitive questions, unsupported claims, ambiguous compliance disclosures, or final submission when approval is required. Browser discovery and browser application are separate stages so an aggregator cannot silently become the authoritative application target.

## 6. Record the outcome

Log the company, title, canonical URL, timestamp, tailored artifact path, answers supplied, and one of: submitted, skipped, blocked, or withdrawn. Keep the log private.

## Scheduling

Run the discovery command hourly with a scheduler such as cron, systemd, GitHub Actions with encrypted private inputs, or an agent automation. Do not place candidate data in a public CI repository.

# Deterministic form mapping

The embedded browser can now identify visible form labels, required controls,
and select options. `planApplicationForm` maps exact common identity fields and
the approved résumé artifact. It stops before filling anything if a required
field is unknown or duplicated, or if verification is detected. Greenhouse and
Ashby have a small set of exact identity-field aliases. Optional free-text
questions remain blank. Complete provider-specific adapters are still needed
for conditional controls and site-specific forms.

## Single-application runner

`npm run application:run` reads one private application package from
`OPENAPPLY_PACKAGE`. The package contains the official `job` and configured
source, candidate facts,
authorized handoff, generated résumé source, verified PDF path, and optionally
the employer confirmation text. The runner verifies the PDF again, checkpoints
each stage in encrypted local storage, fills supported fields in the signed-in
BrowserOS profile when the package has a local endpoint, and records
`submitted` only after a new confirmation appears.
It returns `waiting-human` with an exact blocker for unknown required fields,
missing confirmation configuration, ambiguous submit controls, or final
approval required by policy. Guarded exact-domain account creation and scoped
email-code entry are available when configured. It supports up to five guarded
form steps; arbitrary portal questions still need a human or a provider adapter.
Before login or form filling, the runner requires the original requisition ID
in a stable application path. It pauses generic-URL flows until a
provider adapter can prove job identity. A receipt that leaves the original
job path becomes uncertain. Provider-specific receipt binding remains a
release gate for portals that use generic application URLs.
If final approval is required, set `OPENAPPLY_APPROVE_JOB_ID` to the exact job
ID on the next run. Other human handoffs use the saved same-tab resume path. The
official posting, PDF hash, source fingerprint, and page state are rechecked
before submission. Older checkpoints without both fingerprints cannot resume
automatically and require operator inspection before recovery.
