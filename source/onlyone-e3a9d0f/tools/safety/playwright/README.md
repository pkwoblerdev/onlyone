# Live CDP check with Playwright

OS-8 needs one physical screenshot of the **real onlyone window**. `tools/safety/live.cjs`
takes it over Chrome DevTools Protocol, in two ways:

| mode | what it proves | who starts the app |
| --- | --- | --- |
| `--launch <appDir>` | this checkout paints a real window under a throwaway profile | the script |
| `--url <endpoint>` | a running app answers CDP and can be shot | a human / another test |

This repository ships neither Playwright nor a browser toolkit, and the check **never
installs one**: with no toolkit it uses the WebSocket that Node already provides (or
`node_modules/ws`), and if that is missing too it stops with
`{"status":"not_run","reason":"playwright/ws absent"}` and exit code 2.

## 1. Launch mode — the OS-8 proof

```powershell
node tools\safety\live.cjs --launch D:\pkwobler.projectsNW\1code\worktrees\deepseek\os-isolation --out $env:TEMP\os8-shots
```

What it does, in order:

1. takes a free port on `127.0.0.1` and a fresh `mkdtemp` profile under `%TEMP%`
   (never `%APPDATA%\onlyone`, so real history, keys and settings are untouched);
2. spawns `node_modules\.bin\electron.cmd . --remote-debugging-port=<port> --user-data-dir=<temp>`
   in `<appDir>` (a `.cmd` needs `cmd.exe`, so on Windows the shim is spawned through the shell);
3. waits up to **60 s** for `http://127.0.0.1:<port>/json/list`, then up to 20 s for the
   first `page` target to get a title;
4. lets the first paint settle (1.5 s) and sends `Page.captureScreenshot`;
5. writes the PNG into `--out` and, in a `finally` block, kills **only the tree it
   spawned**: `taskkill /PID <own pid> /T /F` (no sweep by image name, so a running
   onlyone of the owner survives);
6. proves the cleanup: the debugging port stops answering, the spawned process has
   exited, and `Get-CimInstance Win32_Process` finds no `electron.exe` whose command
   line still contains this run's unique profile path;
7. on a green run the temporary profile is removed; a red run keeps it as evidence.

Expected success (exit 0):

```json
{"ok":true,"status":"ok","title":"onlyone","url":"file:///.../src/renderer/index.html",
 "screenshot":"C:\\Users\\you\\AppData\\Local\\Temp\\os8-shots\\onlyone-....png",
 "bytes":43257,"pid":9512,"port":52948,"backend":"node-websocket","exit":0,
 "cleanup":{"killed":true,"method":"taskkill /PID 9512 /T /F","exited":true,
            "endpointClosed":true,"leftoverPids":[],"treeGone":true,"profileRemoved":true}}
```

If Electron cannot start (no display, sandbox error, missing `npm install`), stdout is
`{"ok":false,"status":"not_run","reason":...,"stderr":"<exact tail>"}` and the exit code
is 2. No file is written and no picture is invented.

## 2. Attach mode — shoot an app someone else already started

```powershell
# installed copy
"D:\1code\onlyone\onlyone.exe" --remote-debugging-port=9222
# or from a source checkout
npx electron . --remote-debugging-port=9222

node tools\safety\live.cjs --url http://127.0.0.1:9222 --out $env:TEMP\onlyone-cdp
# or
$env:ONECODE_CDP_URL = "http://127.0.0.1:9222"; node tools\safety\live.cjs
```

Wait until `http://127.0.0.1:9222/json/version` answers. Attach mode does not kill
anything: the app is someone else's process.

## 3. Run the tests

```powershell
node tests\run-os-real-onlyone.cjs   # launches this checkout, exits 2 on not_run, 1 on a failed assertion
node tests\run-os-real-cdp.cjs       # target parsing + the not_run paths, no window needed
```

`run-os-real-onlyone.cjs` asserts the PNG exists, is a real PNG larger than 10 KB, has a
`onlyone` title, comes from `src/renderer/index.html` of this worktree, and that after
cleanup neither the port answers nor any `electron.exe` carries the run's profile. It is
**not** in `package.json` yet (this branch may not edit it); wire it into `test:os` when
the suite owner allows.

`run-os-real-cdp.cjs` stays the honesty test for the attach path: without
`ONECODE_CDP_URL` it reports `not_run` in its notes and exits 0 because it is a unit-level
suite — the physical proof is `run-os-real-onlyone.cjs`, which exits 2 when no window was
captured. A `not_run` line is always a reported gap, never a green capture.

## If you deliberately install Playwright

A human decision, outside this repository (no new dependencies here):

```powershell
mkdir C:\scratch\pw; cd C:\scratch\pw; npm init -y; npm i playwright; npx playwright install chromium
$env:NODE_PATH = "C:\scratch\pw\node_modules"
node D:\pkwobler.projectsNW\1code\tools\safety\live.cjs --url http://127.0.0.1:9222
```

The script prefers `require('playwright')` when it resolves and reports
`"backend":"playwright"`; otherwise it stays on raw CDP and reports `"backend":"node-websocket"`.
Launch mode always uses raw CDP: Playwright's `browser.close()` would take the app down
outside our own cleanup.

## What exit code 2 with `not_run` means

| reason | meaning |
| --- | --- |
| `playwright/ws absent` | no Playwright and no WebSocket implementation at all |
| `electron shim not found` | `node_modules/.bin/electron.cmd` is missing (no `npm install`) |
| `app exited before a window appeared (code N): ...` | Electron died at startup; stderr tail is included |
| `CDP endpoint not reachable: ECONNREFUSED` | nothing is listening on that port |
| `no page target at <url>` | CDP answered, but the app has no `page` target |
| `page target never got a title` | a target exists but the renderer never loaded; the PNG is kept as evidence, status stays `not_run` |
| `CDP returned no image` / `screenshot failed: ...` | attached, but the screenshot did not arrive |
| `no CDP endpoint: ...` | neither `--url` nor `ONECODE_CDP_URL` was given (attach mode only) |
