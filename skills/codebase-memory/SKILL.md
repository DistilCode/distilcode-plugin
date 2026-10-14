---
name: codebase-memory
description: "Use when the user wants persistent codebase memory for a repo — remembering features, entrypoints, or a repository overview across sessions. Use ONLY for opting a repo into memory, seeding it, or querying it — not for general file search."
---

# Codebase Memory

Persistent per-repo memory: a repository overview plus named features (description, entrypoints, files, symbols, notes). Off by default per repo. Memory tools (`repoOverview`, `addFeature`, `modifyFeature`, `removeFeature`, `getFeature`, `listFeatures`) only work after this skill enables the repo.

## Enable memory for the current repo

1. Find the data dir: `DISTILCODE_DATA_DIR`, else `$XDG_DATA_HOME/distilcode`, else `~/.local/share/distilcode`. This is the same on every OS, Windows and macOS included (the CLI resolves it with xdg-basedir).
2. Read `<data>/agent-behaviours.json` (`{version: 1, repos: {...}}`; missing file counts as `{version: 1, repos: {}}`).
3. Compute the repo key: `git rev-parse --show-toplevel` when inside a worktree, else the canonical directory (absolute, symlinks resolved).
4. Write `repos["<key>"].codebaseMemory = true`, preserving every other field. Create `repos`/the entry when absent.
5. Seed it: save a `repoOverview`, then `addFeature` for each meaningful feature. Paths relative to the repo; names normalize to lowercase hyphenated form.

## Disable

Set that repo's `codebaseMemory` to `false`. Stored entries are kept, tools just stop being exposed.

## Rules

- If the memory tools are missing or refuse with "disabled", enable first — do not work around it.
- Never flip the flag for a repo the user didn't ask about. Never touch other repos' entries.
- Feature paths must be repo-relative files that exist; verify against source before saving.
