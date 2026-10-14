# DistilCode (Claude Code and Codex plugin)

DistilCode CLI features for Claude Code and Codex, from one directory (see
[Codex](#codex) for what differs). State is shared with the CLI: codebase
memory and the ponytail/caveman toggles live in the same files under
`~/.local/share/distilcode/` (or `$XDG_DATA_HOME/distilcode`, or `DISTILCODE_DATA_DIR`).

## Install

```sh
claude plugin marketplace add DistilCode/distilcode-plugin
claude plugin install distilcode@distilcode-marketplace
```

Or from a local clone: `claude plugin marketplace add ./distilcode-plugin`.

Needs only `node` on PATH. No `npm install`.

## Features

| Feature | Where | What it does |
|---|---|---|
| Codebase memory | `servers/`, `skills/codebase-memory/` | MCP tools (`repoOverview`, `addFeature`, `modifyFeature`, `removeFeature`, `getFeature`, `listFeatures`). Off per repo until the skill enables it |
| Memory at session start | `hooks/` SessionStart | When memory is on for the repo, injects the overview, verified commands and feature list |
| rtk shell compaction | `hooks/` PreToolUse + PostToolUse | Rewrites Bash/PowerShell commands through `rtk rewrite`. Uses the rtk shipped beside an installed DistilCode CLI (symlinks followed, macOS app bundle included), then `~/.distilcode/bin`, then PATH; otherwise downloads it once in the background to `~/.distilcode/bin/rtk-<version>/`. Strips rtk's "No hook installed" nag. Disable with `DISTILCODE_NO_TOKEN_KILLER=1` |
| PowerShell compaction (Windows) | `scripts/powershell-shape.js` | `ls`/`dir`/`gci`, `Select-String`, `ps`/`Get-Process` and path lists are captured as objects and printed in the grep/glob shapes, port of the CLI's `powershell-shape.ts`. PowerShell aliases with no real binary (`ls`, `ps` on stock Windows) are never sent to rtk |
| Mode toggles | `commands/distilcode.md`, `skills/distilcode-modes/` | `/distilcode <mode> on/off`, or ask in plain words |
| Ponytail mode | `prompts/ponytail.md` | Lazy, minimal-diff coding ladder. **On by default**, like the CLI |
| Caveman mode | `prompts/caveman.md` | Compressed replies. Off by default |
| `explore` agent | `agents/explore.md`, `hooks/` SubagentStart | The CLI's explore agent (Glob/Grep/Read/Bash/web). When memory is on, a hook gives it the memory workflow plus a snapshot, and it updates memory as it learns. Repo files stay read-only |
| `smart-bash` agent | `agents/smart-bash.md` | Haiku shell runner; keeps noisy command output out of the main context |

## Toggling ponytail and caveman

Type any of these as the whole prompt. A hook catches them, so they cost no model turn:

```
/distilcode ponytail off       # on | off | status (no action flips it)
/distilcode caveman on repo    # scope: session | repo | global (default global)
/distilcode                    # show both modes
caveman off session           # bare word works when an argument follows
stop caveman                  # off for this session
normal mode                   # both off for this session
```

Precedence: session > repo > global > default. Setting a wider scope clears
the narrower overrides that apply to you, so the new value takes effect. If the
hook doesn't catch a prompt, the `/distilcode` slash command does the same thing,
at the cost of one short reply. You can also just ask ("turn caveman off for this
repo"): the `distilcode-modes` skill runs the same script.

The full mode text is injected once per context (again after `/clear` or
compaction). After that, caveman adds a one-line reminder each turn.

## Codex

The same directory is a Codex plugin: `.codex-plugin/plugin.json` is the
manifest (hooks inline, skills from `skills/`, MCP from `.codex-mcp.json`).
Scripts, prompts, skills and the memory server are shared with the Claude
build; `hooks.js --codex` switches the few protocol differences.

```sh
codex plugin marketplace add DistilCode/distilcode-plugin
# or from a local clone:
codex plugin marketplace add ./distilcode-plugin
```

Then enable `distilcode@distilcode-marketplace` from `/plugins` (or
`[plugins."distilcode@distilcode-marketplace"] enabled = true` in
`config.toml`). Codex doesn't trust plugin hooks automatically: review and trust
them once in `/hooks`.

| Claude Code | Codex |
|---|---|
| `distilcode:explore` agent | Not packageable in Codex plugins. The SubagentStart hook gives the memory snapshot to Codex's built-in `explorer` subagent instead |
| `smart-bash` agent | Not available |
| `/distilcode` slash command | No plugin slash commands. Type the bare forms (`caveman on`, `stop caveman`, `normal mode`) or ask; the `distilcode-modes` skill handles it |
| PreToolUse rewrite, permission flow untouched | Codex only accepts `updatedInput` with `permissionDecision: "allow"`. Sandbox and approval prompts still apply through `PermissionRequest` |
| PowerShell object compaction (PostToolUse) | Off: Codex can't replace tool output. rtk rewrites still apply, using PowerShell quoting on Windows |
| `${CLAUDE_SESSION_ID}` in the modes skill | `modes.js` reads `CODEX_SESSION_ID` |

## Versioning

Both manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) pin `version`. Bump both on every release or `claude plugin update` / Codex's plugin cache will keep serving the old copy.
