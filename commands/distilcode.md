---
description: Toggle DistilCode modes, e.g. `/distilcode caveman on` or `/distilcode ponytail off repo`
argument-hint: "[ponytail|caveman] [on|off|toggle|status] [session|repo|global]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/modes.js" $ARGUMENTS --session "${CLAUDE_SESSION_ID}"`

Repeat the output above to the user verbatim and nothing else.
