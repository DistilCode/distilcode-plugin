#!/usr/bin/env node
// Ponytail / caveman toggles, stored in the CLI's own agent-behaviours.json so
// a toggle made in Claude Code also applies to the DistilCode CLI and back.
// Precedence matches session/agent-behaviours.ts: session > repo > global >
// default (ponytail on, caveman off).
//
// CLI: node modes.js [ponytail|caveman] [on|off|toggle|status] [session|repo|global] [--session <id>]
// (no mode, or `status` alone, reports both modes)
"use strict"

const fs = require("node:fs")
const path = require("node:path")
const { repoKeyFor, behavioursFile } = require("../servers/mcp-codebase-memory.js")

const MODES = ["ponytail", "caveman"]
const DEFAULTS = { ponytail: true, caveman: false }
const SCOPES = { session: "session", once: "session", repo: "repo", global: "global", always: "global" }

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(behavioursFile(), "utf8"))
    if (parsed?.version === 1) return { global: {}, repos: {}, sessions: {}, ...parsed }
  } catch {}
  return { version: 1, global: {}, repos: {}, sessions: {} }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(behavioursFile()), { recursive: true })
  const tmp = `${behavioursFile()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, "\t"))
  fs.renameSync(tmp, behavioursFile())
}

function readModes({ cwd, sessionID }) {
  const store = readStore()
  const repo = store.repos[repoKeyFor(cwd)] ?? {}
  const session = (sessionID && store.sessions[sessionID]) || {}
  return Object.fromEntries(MODES.map((m) => [m, session[m] ?? repo[m] ?? store.global[m] ?? DEFAULTS[m]]))
}

/** Sets a mode at one scope and clears narrower overrides for the caller, so the new value actually takes effect. */
function setMode({ cwd, sessionID, mode, value, scope }) {
  const store = readStore()
  const key = repoKeyFor(cwd)
  const drop = (obj, k) => {
    if (obj?.[k]) delete obj[k][mode]
  }
  if (scope === "session") {
    if (!sessionID) throw new Error("session scope needs a session id")
    store.sessions[sessionID] = { ...store.sessions[sessionID], [mode]: value }
  } else if (scope === "repo") {
    store.repos[key] = { ...store.repos[key], [mode]: value }
    drop(store.sessions, sessionID)
  } else {
    store.global = { ...store.global, [mode]: value }
    drop(store.repos, key)
    drop(store.sessions, sessionID)
  }
  writeStore(store)
}

/** Parses `[on|off|toggle|status] [scope]`, applies it, and returns a one-line result. */
function command({ cwd, sessionID, mode, args }) {
  let action = "toggle"
  let scope = "global"
  for (const a of args.map((x) => x.toLowerCase())) {
    if (["on", "off", "toggle", "status"].includes(a)) action = a
    else if (SCOPES[a]) scope = SCOPES[a]
    else throw new Error(`unknown argument "${a}" (expected on|off|toggle|status and session|repo|global)`)
  }
  const current = readModes({ cwd, sessionID })[mode]
  if (action === "status") return `${mode}: ${current ? "on" : "off"}`
  const value = action === "toggle" ? !current : action === "on"
  setMode({ cwd, sessionID, mode, value, scope })
  return `${mode}: ${value ? "on" : "off"} (${scope})`
}

/** `[mode] [action] [scope]` as typed after `/distilcode`; returns the result lines. */
function run({ cwd, sessionID, args }) {
  const [first, ...rest] = args.map((a) => a.toLowerCase())
  if (!first || (first === "status" && rest.length === 0))
    return MODES.map((mode) => command({ cwd, sessionID, mode, args: ["status"] }))
  if (!MODES.includes(first)) throw new Error(`unknown mode "${first}" (expected ${MODES.join(" or ")})`)
  return [command({ cwd, sessionID, mode: first, args: rest })]
}

module.exports = { MODES, readModes, setMode, command, run }

if (require.main === module) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf("--session")
  // Codex skills can't template the session id; Codex exports it to shell commands instead.
  const sessionID = i === -1 ? process.env.CODEX_SESSION_ID || undefined : argv.splice(i, 2)[1]
  try {
    console.log(run({ cwd: process.cwd(), sessionID, args: argv }).join("\n"))
  } catch (e) {
    console.log(`distilcode: ${e.message}`)
    process.exitCode = 1
  }
}
