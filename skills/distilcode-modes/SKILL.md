---
name: distilcode-modes
description: "Use when the user asks to turn ponytail mode (lazy minimal-diff coding) or caveman mode (compressed replies) on or off, or asks whether either is on. Covers natural phrasings like \"be less verbose\", \"talk normally again\", or \"stop the minimal-diff thing\"."
---

# DistilCode modes

Two modes, shared with the DistilCode CLI:

- **ponytail**: lazy, minimal-diff coding ladder. On by default.
- **caveman**: compressed replies. Off by default.

## Change or check a mode

Run exactly one command with the Bash tool, from the session's working directory:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/modes.js" <ponytail|caveman> <on|off|status> [session|repo|global] --session "${CLAUDE_SESSION_ID}"
```

With no mode (`node ".../modes.js" status --session ...`) it reports both.

In Codex, where those placeholders aren't filled in: the script is `../../scripts/modes.js` relative to this SKILL.md, and drop `--session` (the script reads `CODEX_SESSION_ID` itself).

Pick the scope from what the user said:

- "for now", "this chat", "this session" → `session`
- "in this repo", "for this project" → `repo`
- "always", "everywhere", or no scope given → `global` (the default)

Then report the printed line to the user, nothing more.

## Rules

- Change only the mode the user named. "Normal mode" or "talk normally" means both off for the session.
- Don't edit `agent-behaviours.json` by hand. The script keeps scope precedence (session > repo > global) consistent.
- The mode's instructions reach you on the user's next message. If a mode was turned off, stop following its earlier instructions right away.
- The user can also type `/distilcode caveman on` or `/distilcode ponytail off repo` themselves. Mention that only if they ask how.
