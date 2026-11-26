# OpenApply product flow (design draft)

This document defines the intended hosted product. It does not describe a feature
that is already available in `main`. The open-source self-hosted workflow remains
usable without a paid account; hosted access is a separate entitlement.

## Candidate journey

1. **Account and access.** A user creates an account, verifies their email, and
   chooses a hosted plan or an explicitly granted free access period. Stripe is
   the planned hosted billing provider. The server records Stripe customer and
   subscription IDs, never card data.
   A verified billing webhook updates a local entitlement record. The server
   checks that record before accepting a new run, again before a worker starts,
   and as part of the atomic final-submit authorization fence.
   Expiry stops new work; an already claimed submission follows its recovery
   protocol rather than being clicked again.
2. **Guided intake.** Ask whether the user is studying, graduating soon, a new
   graduate, or already working. Ask only relevant follow-up questions. Collect
   the master resume, optional transcript and portfolio links, work authorization,
   location and relocation preferences, target roles, compensation preferences,
   daily cap, and submission policy. A transcript is optional unless the user
   targets roles that require one. Every uploaded file is private and deletable.
3. **Fact review.** Parse documents into candidate facts with source references.
   The user confirms extracted dates, employers, education, metrics, skills, and
   authorization answers before those facts can be used. Store structured facts
   as the source of truth; render the existing Markdown templates as portable,
   human-readable views. Never treat document text as agent instructions.
4. **Search policy.** Let the user select job families, seniority, locations,
   work arrangements, exclusions, and a daily application cap. The service
   discovers official postings on a schedule. Job boards are lead sources;
   each lead must resolve to a live employer posting before it enters the
   application queue. Deduplicate by official requisition or canonical URL.
5. **Rank and apply.** Rank verified matches by qualifications and preference,
   then prioritize roles first seen or published within 24–48 hours. Keep older
   eligible roles in the queue when recent supply is exhausted. Before each
   application, recheck the posting, entitlement, user consent, daily quota,
   candidate evidence, and duplicate-submission journal.
6. **Tailor artifacts.** Generate a separate resume for the exact job from
   approved facts. Jake's LaTeX template is the default layout; preserve its
   attribution and permit an approved alternative. Use result–measurement–method
   bullets only where the underlying facts support all three parts. Generate a
   cover letter only from approved facts when requested. Attach the transcript
   only when the user supplied it and the employer asks for it. Validate the
   generated PDF's text, pages, links, and visual layout before upload.
7. **Apply and recover.** An isolated browser session fills the employer form.
   Known fields use deterministic adapters. Unknown, legal, demographic, or
   identity-verification questions pause the run and notify the user. On resume,
   re-read the live page and manual edits before acting. Reserve an exact-job
   submit intent before the final click; require an employer confirmation or
   record an uncertain outcome for manual reconciliation. Never retry a final
   click merely because the worker crashed.
8. **Show outcomes.** The dashboard separates confirmed submissions, waiting
   for user action, uncertain submissions, rejected matches, and closed jobs.
   Show the official job link, tailored artifact, answer provenance, timestamp,
   and receipt. Offer export, deletion, and cancellation controls.

## Hosted system boundary

```text
Web app / account / billing / intake / handoff
                    │
       entitlement + consent + candidate vault
                    │
      shared discovery → verified job index
                    │
       candidate ranking → durable queue
                    │
       isolated browser worker per candidate batch
                    │
          exact-job journal + employer receipt
```

The Cloudflare edge can serve the web UI and small control-plane requests. It
does not operate a user's laptop or provide the Chromium runtime. The planned
AWS container worker runs the browser. Candidate secrets and browser state must
remain tenant-isolated and encrypted outside its ephemeral filesystem. A browser
session requires explicit user sign-in; do not copy the user's daily Chrome
profile to the cloud. CAPTCHA and MFA require a user handoff.

The service should fetch official feeds and APIs for discovery when permitted.
Browser automation is for pages that require it, especially the final employer
application. Reuse a candidate's isolated session across a bounded batch, then
stop it; avoid a permanently running browser per subscriber.

## PDF compilation decision

Keep the LaTeX source and Jake layout regardless of compiler. The existing
Overleaf automation works for the self-hosted workflow, but a hosted product
must not require every candidate to own or sign in to an Overleaf account just
to receive a PDF. Benchmark a sandboxed local TeX compile inside the worker
against the current Overleaf path for latency, visual parity, failure rate, and
cost. Prefer local compilation if it passes the same PDF checks. Keep Overleaf
as an optional authoring or fallback path, subject to its account and service
rules. Do not silently switch the candidate's selected resume layout.

## Billing and plan rules to finalize

- **Monthly:** recurring access for one billing month. Price is undecided.
- **Semester:** prepaid access for a clearly stated fixed duration; define the
  number of months before creating a price. Avoid an academic-calendar label
  with ambiguous start and end dates. Price is undecided.
- **Free access:** an explicit grant for friends, family, or beta users, with
  an expiry and the same safety controls. Never store a fake paid subscription.
- Plans must state included application volume and any fair-use limit. Do not
  advertise unlimited applications until per-application costs and provider
  limits are measured.
- Billing events are authenticated and idempotent. The user can view renewal,
  cancellation, and access end dates. A payment redirect alone is not proof
  of an active entitlement.

## Release acceptance

1. A candidate can complete account, payment or free grant, guided intake,
   fact confirmation, search preferences, and browser sign-in without a CLI.
2. Billing tests cover duplicate, delayed, out-of-order, failed-payment,
   cancellation, refund, and plan-change events. An unauthorized tenant cannot
   read another candidate's facts, artifacts, browser state, or receipt.
3. End-to-end tests cover recent and older discovery tiers, duplicate leads,
   ambiguous requirements, custom controls, multi-step forms, resume upload,
   a human edit during pause, restart before and after submit intent, and exact
   employer confirmation. No test should submit a real application by default.
4. A monitored, consented real-site beta measures time per stage, confirmed
   completion rate, handoff frequency, duplicate prevention, cost per confirmed
   application, and failure reasons by provider. Claims of broad site coverage
   or a 99% autonomous rate require this evidence.
5. Security review covers billing entitlement bypass, tenant boundaries,
   prompt injection in postings and uploads, stored sessions, account recovery,
   retention, export, and deletion. Public release follows resolution of its
   findings and the existing release gates.

## Reviewable implementation sequence

1. Hosted account and Stripe entitlement contract with webhook tests and free grants.
2. Guided intake, document upload, structured fact review, and Markdown export.
3. Cloud discovery index and candidate ranking with freshness and deduplication.
4. PDF compiler benchmark and selected production renderer with visual checks.
5. Tenant-scoped browser session onboarding, form adapters, pause/edit/resume,
   and exact-job receipt recovery.
6. Dashboard, notification, export/deletion, billing portal, and measured beta.

Each PR should leave the existing self-hosted workflow functional. The cloud
draft PR stack is staging work, not evidence that this hosted flow is live.
