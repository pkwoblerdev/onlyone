# OS: isolation and plugins

Working notes for plan §7. Each gate is a command; tests are written before code.

- [User guide](USER-GUIDE.md) — install a plugin, approve capabilities, read the journal, roll back, and what the boundary does and does not cover.
- [ADR-0001](ADR-0001-isolation.md) — Job Object first, AppContainer later, no new dependencies.
- [Threat model](THREAT-MODEL.md) — what a plugin and a scanned target can do to us.
- [Evidence](EVIDENCE.md) — what counts as proof in a finding.
- [Plugin format](PLUGIN-FORMAT.md) — manifest, capabilities, lifecycle.

Status 03.11.2026: the sandbox, plugin host, plugins screen and safety checks are implemented and covered by tests. Merge and release are owner-gated.
