# Hosted paid queue gate

The hosted enqueue path accepts the subject only from authenticated server context. It checks the trusted run's subject binding, current consent, and a fresh durable entitlement before sending an identifier-only SQS message. The cloud worker reads the same entitlement store after claiming its lease and again immediately before reserving a submit intent. Missing or unreadable billing state returns `payment_required` without opening an employer page or clicking Submit.

This is a staging contract; the production HTTP router, SQS sender, DynamoDB entitlement reader, browser task poller, and billing/consent fencing transaction are separate integration work. A payment-required SQS delivery is not acknowledged by this slice; a production poller must park or delay it durably to avoid repeated receives. Local open-source runs remain independent of hosted billing.
