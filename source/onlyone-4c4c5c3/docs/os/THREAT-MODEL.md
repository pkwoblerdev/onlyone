# Threat model (STRIDE-lite)

Assets: chat history, provider keys, profile (`%APPDATA%\onlyone`), workspace files, the agent's
decisions, the user's machine.

Actors: the user, a plugin author, a scanned repository (untrusted input), the model provider.

| Threat | Path | Mitigation | Residual |
|---|---|---|---|
| Spoofing | Plugin claims another id/version | id regex, tree hash, ed25519 signature when a key is configured | Unsigned plugins allowed only with an explicit warning |
| Tampering | Plugin files changed after install | Tree hash checked at load; hash recorded on install | Local admin can rewrite disk and record |
| Repudiation | Plugin denies a call | Append-only journal: install, grants, calls, refusals | Journal is local, not signed |
| Information disclosure | Plugin reads chats/keys | No such capability exists; host strips env; only workspace root for `fs.read` | Job Object does not block paths; host check is the boundary |
| Denial of service | Plugin loops, forks, eats memory | Job Object limits, call timeout, output cap, kill switch | CPU rate control not implemented |
| Elevation | Plugin starts a shell or another process | `exec` allowlist without shell, ActiveProcessLimit | A child process can still write files |
| Prompt injection | Scanned code tells the agent to ignore rules | Target text is data; routing is deterministic; findings need Evidence | Model may still follow text; verifier and two-key rule reduce impact |

Out of scope now: network egress control, cryptographic trust of the whole chain, remote plugin
repositories.
