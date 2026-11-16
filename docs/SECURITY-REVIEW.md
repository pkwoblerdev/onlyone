# onlyone 1.3.38 — source and artifact security review

Local candidate revision `814623c8199e040ad4a2cc2f1bf137c910e5ccc0`. This is a bounded technical review, not proof that the distribution has no secrets or vulnerabilities.

The standard source scanner inspected 1,082 of 1,145 files and returned no blocking matches using its built-in file/rule and placeholder exceptions. A second run with these exceptions disabled produced the following matches:

| Rule | Matches | Review |
|---|---:|---|
| Private key headers | 3 | One is the scanner's self-check; two are deliberate redaction test blocks. Both complete blocks failed private-key parsing. |
| Key-shaped strings | 61 | All contain explicit fixture markers after replacement, in tests or scanner checks. |
| Slack token pattern | 1 | A redaction fixture carrying an explicit test marker. |
| JWT | 2 | The same redaction fixture; the payload uses a canonical example subject and its signature matches a known example signing key. |
| Bearer | 6 | Test fixtures; five contain explicit markers and one embeds the JWT example. |
| Literal secret | 19 | Test fixtures with explicit placeholder markers. |
| Agent branch, private path, report name | 4 | Scanner self-checks and exporter safety tests. |

The top-level public-folder scan matches fixture and self-check paths because the source scanner's exclusions are scoped relative to the source root. It does not mean every match is a live credential. Nor does the classification prove that any original credential was never used; if an actual key was previously exposed, it must be revoked separately.

A limited raw-byte scan of the 63 binary source files found none of the selected common key formats. Compressed or encoded content, formats outside those checks, prior Git history, remote services and live key validity were not verified. Re-run secret scanning on the final repository and release assets before publishing.

Installer and portable contain byte-identical compressed application payloads, and that payload passed an archive integrity check. It contains the inspected application archive and third-party notice resources. The executables are unsigned. CLI checks used isolated profiles and a local fixture server; a clean-machine installation and lifecycle check remains outstanding.

For the later candidate revision 4c4c5c323529f0468236423702d9706d1448e966, the standard scanner inspected 1,083 of 1,146 files and returned no blocking matches. The detailed strict-scan figures above relate to the earlier revision. The full test run exited zero but skipped some AppContainer and debugging scenarios. The private reporting channel and the origin and rights of the phone frame remain unconfirmed. Six moderate findings remain in development dependencies; the recorded production audit reported zero known vulnerabilities.
