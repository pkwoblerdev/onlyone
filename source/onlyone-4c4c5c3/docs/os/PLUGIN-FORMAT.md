# Plugin format

A plugin is a directory with `plugin.json`, an entry file and optional assets. Nothing is loaded
into the main process.

```json
{
  "id": "demo",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "worker.cjs",
  "capabilities": ["fs.read", "storage"],
  "selftest": { "method": "selftest" }
}
```

Capabilities (default deny):

| Capability | Meaning | Enforced by |
|---|---|---|
| `fs.read` | Read under the workspace root | Host path check |
| `exec` | Run an allowlisted command | Host allowlist, no shell |
| `net` | Reach allowlisted hosts | Host allowlist (network egress is not OS-blocked yet) |
| `storage` | Plugin-scoped encrypted storage | Host API |
| `events` | `files.changed`, `run.finished` | Host API |
| `ui.panel` | One panel in the plugins screen | Renderer |
| `agent.tools` | Tools prefixed `plugin_<id>_` | Agent loop |

Lifecycle: verify (schema, hash, signature) → install disabled → human approves capabilities →
start worker and run `selftest` → enable. A wider capability set on update keeps the plugin
disabled until approved. Rollback keeps the previous version.

Never available: chat history, provider keys, the profile directory, writing outside workspace.
