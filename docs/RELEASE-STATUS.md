# Release preparation status

Candidate 1.3.38, revision `4c4c5c323529f0468236423702d9706d1448e966`. Publication is not yet approved; see the outstanding items below.

- Project-authored design guidance replaces the previous instructions. Automatic update and packaged remote relay defaults are disabled, including legacy settings; a manually configured update feed remains possible.
- The recorded `npm test` run exited 0 on this revision; some AppContainer and debugging scenarios were skipped or not run. A zero exit code does not establish that those scenarios passed.
- Source export manifest covers 1,146 files. The installer and portable executable contain the same inspected application payload. The Windows executables are unsigned.
- The recorded dependency audit reported no known production vulnerabilities and six moderate development dependency findings. These affect build tooling and remain to be resolved or accepted after review.
- Installation, upgrade and removal on a clean Windows system still need independent verification. The existing reports contain conflicting claims about the installation lifecycle.
- The security reporting channel is not established. Do not rely on the email addresses or response times mentioned in superseded reports.
- The founder created the logo using AI; the source and rights of the phone frame have not been confirmed. The founder has chosen to retain it for now. Third-party license notices must remain intact. No assurance of legal clearance is implied.

Source: [onlyone-4c4c5c3](../source/onlyone-4c4c5c3/). Evidence: [test record](../source/evidence-1.3.38/run.json) and [security review](SECURITY-REVIEW.md).
Independent checks on 2026-11-16: packaged CLI passed with an isolated profile and local fixture; AppContainer passed 17 checks for file access, network denial, capability tokens, cleanup and resource limits. One live network-on loopback check was skipped because the Windows firewall exemption requires administrator rights.
