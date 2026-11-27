# Local Jake PDF renderer: first slice

`renderLocalJakePdf` compiles an exact `createJakeResumeSource` output in a
private staging directory and verifies the result against the job and approved
candidate facts before returning its path. It accepts a trusted absolute
Tectonic binary path and prepopulated offline cache path from deployment
configuration. The work directory must be a canonical private path; symlinked
parent components are rejected. Both paths are checked before the compiler runs; neither may be
selected by a candidate, queue message, or browser page.

The subprocess gets a private `HOME`, an explicit `TECTONIC_CACHE_DIR`, and no
inherited AWS credentials. It runs with `--untrusted`, `--only-cached`, and a
20-second wall timeout. Source is limited to 200 KB; stdout/stderr capture to
64 KB; PDF output to 5 MB. The source must match the regenerated bundled Jake
output exactly. The renderer rejects symlinked and non-PDF outputs, moves the
validated PDF atomically within one filesystem, runs `verifyResumePdf`, and
removes intermediate files and invalid final output.

The optional real-engine fixture runs when `OPENAPPLY_TECTONIC_BIN` and
`OPENAPPLY_TECTONIC_CACHE` point to a locally installed Tectonic binary and an
already-populated cache. It compiles a synthetic candidate's Jake source
offline and passes the generated PDF through the full verifier.

This module is not registered in a cloud task. A follow-up must pin the Linux
Tectonic binary and bundle in the container image, ensure the runtime cache is
read-only, enforce CPU/memory/process and network limits at the OS/container
boundary, benchmark cold and warm renders, and add the disabled preview task
with durable encrypted handoff. Issue #277 tracks those gates. No final Submit
path or production browser deployment is enabled here.
