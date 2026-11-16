# ADR-0001: Job Object first, AppContainer later

Date: 03.11.2026. Status: proposed.

## Decision

Every tool run and every plugin worker goes through `tools/sandbox/win-job.cjs`, which starts the
process inside a Windows Job Object with limits on memory, process count and lifetime.

No new npm dependency: the wrapper calls Windows PowerShell 5.1 with inline C# P/Invoke
(`CreateJobObject`, `SetInformationJobObject`, `AssignProcessToJobObject`, `TerminateJobObject`).
AppContainer is a later step and is not claimed now.

## Why

- B-2 is open: today only `tool-sandbox.cjs` path roots and Chromium sandbox for Desk exist.
- A plugin host without an OS boundary would be a permission list with no teeth.
- koffi or another FFI package would add supply-chain surface for one API family; PowerShell ships
  with Windows.

## Limits, stated honestly

- Job Object limits memory and child processes; it does not restrict file paths or network.
- Without AppContainer, `fs.read` and `net` are enforced by the host API, not by the OS.
- If PowerShell or `Add-Type` is unavailable, the sandbox reports `SANDBOX_UNAVAILABLE` and the
  plugin host refuses to enable plugins.

## Consequences

- Tests must prove: normal run, memory refusal, process-count refusal, timeout kill.
- The plugins screen must say "limits, not a sandbox" while AppContainer is absent.
- AppContainer work is a separate ADR once a SID/profile creation path is chosen.
