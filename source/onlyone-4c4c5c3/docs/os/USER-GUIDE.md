# Plugins and isolation: user guide

This guide covers installing and managing a plugin, and what the isolation boundary actually
does. It describes what exists in this repository today. A plugin is code you choose to trust: it
is not downloaded from a store and nothing here promises that plugin code is safe.

## Install a plugin from the command line

A plugin is a folder with `plugin.json`, an entry file and optional assets; the format and the
capability list are in [PLUGIN-FORMAT.md](PLUGIN-FORMAT.md). From the repository root, with
Node 24:

```bash
node tools/plugin/cli.cjs install <plugin-dir> --profile "%APPDATA%\onlyone"
```

The command validates the manifest, copies the version to
`<profile>\plugins\<id>\<version>\`, records the tree hash and prints one JSON object. It never
enables the plugin. With an empty trust store an unsigned plugin is installed with
`"warning": "no trusted key in the profile: the plugin is unsigned"`. To refuse unsigned
plugins, add a public key first:

```bash
node tools/plugin/cli.cjs trust add <public-key.pem> --profile "%APPDATA%\onlyone"
```

Open the app and go to **Plugins** after installing.

## Approve capabilities

Every plugin declares what it wants; the default is deny. The row shows the requested
capabilities, the granted ones and the ones still waiting for consent. The plugin stays
disabled until you approve it.

**Allow** grants the whole requested set and enables the plugin. An update that asks for more
than the granted set keeps the plugin disabled until you approve the new list again. The
**Connect** button only works for an already approved set.

There is also a command-line approval:

```bash
node tools/plugin/cli.cjs approve <id> --profile "%APPDATA%\onlyone"
```

It grants the whole requested list without showing it to you. Use it only after reading
`plugin.json` yourself; otherwise approve in the window, where the list is visible.

## See the journal

The journal is at the bottom of the Plugins screen, newest first: time, action, plugin, version
and result. It is stored as append-only lines in `<profile>\plugins\journal.jsonl`, and the window
shows the last 200 entries.

Only actions performed in the window are written: approval, disabling, enabling, rollback and
removal. Installs and other actions made with the command line do not add journal lines. The
journal is local and not signed.

## Roll back and remove

Every installed version stays on disk. When a plugin has more than one version, the row offers a
version list; choose a version and press **Roll back**. If the older version asks for wider
capabilities than were granted, it comes back disabled and asks for consent again. The command
line equivalent is:

```bash
node tools/plugin/cli.cjs rollback <id> <version> --profile "%APPDATA%\onlyone"
```

**Remove** deletes the files of all versions. Journal lines about the plugin remain.

## What the sandbox does and does not do

A sandboxed plugin run starts the worker inside one of two boundaries. The command-line host
prints which one was used:

```bash
node tools/plugin/cli.cjs host <plugin-dir> --sandbox --timeout 10000 --memory 268435456 --processes 4
```

- **Job Object** (always available on Windows when the sandbox is requested) limits memory, the
  number of child processes and the lifetime of the worker. It does **not** restrict which files
  the worker opens, its network access or the registry. It is a resource boundary, not a
  filesystem sandbox.
- **AppContainer** (when Windows can create it) gives the worker a token with no network
  capability and read plus execute access only on the plugin folder and a staged copy of
  `node.exe`. Files outside that folder cannot be read and TCP connections fail. This is the
  file and network boundary.

The host tries AppContainer first and falls back to the Job Object only when AppContainer is
unavailable; the JSON then says `"sandboxed": "job"` and gives `sandboxReason`. If no boundary can
be built at all, the host refuses to run the worker (`SANDBOX_UNAVAILABLE`) instead of quietly
running it unsandboxed.

What a plugin never gets:

- **Chats and keys.** There is no capability for chat history, provider keys or the profile
  directory. The host passes only `PATH`, `SystemRoot`, `TEMP` and `TMP` to the worker and blanks
  the profile-related environment variables.
- **Network beyond the allowlist.** With AppContainer the worker has no network at all, even for
  hosts named in a `net` grant. Without AppContainer the `net` capability is only a host-side
  allowlist — a policy check, not a firewall; the OS does not block egress. Treat the list as
  intent and read the plugin code.

What is not covered: CPU rate control (only a timeout), a signed journal, remote plugin
repositories, and any statement about what an approved plugin does with the access it was given.
Approving a plugin is trusting its code.
