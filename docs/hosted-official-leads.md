# Hosted official job leads (staging)

The hosted run creator requires a `LEAD#<id>` / `VERIFIED` row before it can accept an application run. This sync writes that row from an operator-approved official ATS API response. It does not discover jobs from LinkedIn, use candidate credentials, create a run, or submit an application.

## Source and row contract

`OFFICIAL_SOURCES_JSON` is operator configuration, never a browser request. Version 1 permits Greenhouse, Ashby, Lever, and SmartRecruiters board identifiers only. Arbitrary URLs, Workday hosts, and JSON-LD pages are excluded. The fetcher accepts only the matching provider API hostname over HTTPS, refuses redirects, and bounds each response to 8 MiB and 15 seconds. A source may contain at most 500 jobs. An incomplete, failed, duplicate, or identity-mismatched response leaves existing rows alone; they become unusable after their 15-minute expiry.

Each row stores the canonical official employer application URL, provider/employer/requisition identity, a deterministic job key and lead ID, 15-minute expiry, and public source provenance. It contains no candidate data. The same posting refreshes the same lead; different ATS providers cannot collide. A complete refresh closes postings missing from that source. DynamoDB transactions fence both a lead row and its source membership against changed identity and older refreshes. The hosted run creator checks status, expiry, and job key again in its own transaction.

## Build and optional deployment

Build the Lambda bundle with `npm run build:official-lead-sync-lambda`. `deploy/aws/official-lead-sync-staging.yaml` defines the staging Lambda, scoped DynamoDB role, and five-minute EventBridge rule. The stack defaults to disabled. Review the source identifiers and bundle first, then provide the reviewed S3 code location and `OfficialSourcesJson`; enable the sync and schedule explicitly. The event carries no source URL or candidate input. Manual invocation is limited to `{ "mode": "operator-sync" }` for an operator with Lambda invoke permission.

Example operator configuration (replace the board identifiers with actual reviewed employers):

```json
{"version":1,"maxJobsPerSource":250,"sources":[{"provider":"greenhouse","boardToken":"example","company":"Example"}]}
```

This path is staged infrastructure, not evidence of live application completion. The full product still needs an authenticated lead listing and candidate preferences/ranking, a complete approved profile, production browser adapter, provider-specific live validation, and measured beta results.
