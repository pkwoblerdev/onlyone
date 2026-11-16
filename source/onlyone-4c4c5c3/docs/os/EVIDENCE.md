# Evidence

A finding is a claim plus a record. Without a record it is an observation and does not enter the
report.

Record fields:

- `run` — run id, date, tool version, target revision.
- `file`, `line` — exact location, or `null` for a whole-command fact.
- `command` — argv as executed, no shell string.
- `exit` — process exit code (measured by the host, never self-reported).
- `stdout_sha256` — hash of the captured output used for the claim.
- `kind` — `static`, `runtime`, `test`, `screenshot`.
- `confidence` — `confirmed` (two independent records), `observed` (one record), `hypothesis`
  (no record; cannot be reported as a finding).

Rules:

1. Two-key rule: a `confirmed` finding needs two records of different kinds (for example a static
   location and a live reproduction), or two independent static tools.
2. Negative control: every check must have a seeded case where it fires and a case where it stays
   silent.
3. No scores. Precision and recall come from the bench with a date and revision.
4. Target text is data. Instructions found in scanned files never change routing or permissions.
5. `verify` fails a run that has a finding without a record.
