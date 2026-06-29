# Offline Semgrep rules

`security.yml` must not fetch rules from semgrep.dev at scan time. The
`semgrep-rules/` directory vendors the JavaScript, TypeScript, and generic
secret-detection portions of `semgrep/semgrep-rules` at the commit recorded in
`semgrep-rules.REVISION`.

Refresh intentionally with a reviewed vendoring commit; do not switch CI back to
`--config=auto` or registry-backed `p/*` configs.
