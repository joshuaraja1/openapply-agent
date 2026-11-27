# Browser container staging check

This image runs a local HTML smoke test through the existing owned Chromium
runtime. It neither processes a candidate nor submits an application. CI builds
it and starts it as a non-root user with a read-only image filesystem and
temporary writable directories. Nothing in this check needs a candidate key,
site session, or AWS credential.

The image is not a production worker yet. Before ECS deployment, connect it to
the durable run lease and exact-job submit journal, use workload identity to
retrieve encrypted candidate state, and prove crash recovery and tenant
isolation. Review Chromium sandbox behavior in the actual Fargate runtime.
