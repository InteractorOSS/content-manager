# Interactor CMS Sync (tray app) — SCAFFOLD, UNVERIFIED

Phase 3, rung 3 of `FILE-BASED-CONTENT-PLAN.md`'s desktop sync ladder. **This could not
be built or run in the sandbox that generated it — there is no Rust/Cargo toolchain
available there.** Unlike the CLI (`scripts/cms-sync.ts`) and the Obsidian plugin
(`obsidian-plugin/`), which were both compiled, typechecked, and exercised against a
real running CMS, everything under `src-tauri/` here is written against Tauri v2's
documented API shape but has never been through `cargo build`. Treat it as a
well-informed starting point, not working software — expect to spend real time getting
it to actually compile before anything else.

## What it's meant to do

A menubar/tray icon with a small menu (Pull, Push, Open sync folder, Quit) that shells
out to the already-working `scripts/cms-sync.ts` CLI — deliberately thin, so the only
new/unverified surface is "show a tray icon and run a command," not a second
reimplementation of the sync logic itself (which already exists, tested, in the CLI and
the Obsidian plugin).

Config lives in `~/.config/interactor-cms-sync/config.json` (`baseUrl`, `token`,
`syncFolder`, `cmsRepoPath` — where this repo, or at least `scripts/cms-sync.ts` and its
`node_modules`, live on disk, since the tray app shells out to it via `npx tsx`). There
is deliberately no settings GUI in this scaffold — hand-edit the config file. A real
settings window is future work once the basic shell-out mechanism is confirmed working.

## To pick this up

1. Install Rust + the Tauri CLI prerequisites for your OS
   (https://tauri.app/start/prerequisites/).
2. `cd tray-app && cargo build` — fix whatever the compiler flags. Likely candidates:
   Tauri v2's tray/menu API surface may have shifted since this was written; the
   `tauri.conf.json` schema version may need bumping to match whatever `tauri` crate
   version actually resolves.
3. Get the tray icon showing with a working Quit item first — the smallest possible
   working slice — before wiring up Pull/Push.
4. Only then: harden the recurring costs the plan doc calls out for this rung —
   code signing (Apple/Microsoft developer accounts, which this session had neither),
   notarization, auto-update, multi-OS CI builds. None of that is started here.

## Why this exists despite being unverified

The plan explicitly ranks this rung "only if non-technical adoption demands it" — the
CLI and Obsidian plugin already cover the real workflow for the stated audience. This
scaffold exists so a future session with a Rust toolchain has a concrete, reasoned
starting shape (thin shell-out, not reimplemented sync logic) instead of a blank
directory.
