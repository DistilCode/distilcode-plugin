#!/usr/bin/env node
// Hook entry for Claude Code and Codex: `node hooks.js <Event> [--codex]` with
// the hook JSON on stdin. Codex speaks the same protocol with a few differences,
// marked CODEX below. Every path fails open: on any error the hook prints
// nothing and exits 0, so the host carries on unmodified.
"use strict"

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn } = require("node:child_process")
const { readStore, isEnabled, repoKeyFor } = require("../servers/mcp-codebase-memory.js")
const modes = require("./modes.js")
const PowerShellShape = require("./powershell-shape.js")

const PLUGIN_ROOT = path.resolve(__dirname, "..")
const CODEX = process.argv.includes("--codex")
const STATE_DIR = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "distilcode-claude-plugin"), "sessions")
const prompt = (name) => fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", name), "utf8").trim()
const emit = (obj) => process.stdout.write(JSON.stringify(obj))
const context = (event, text) => text && emit({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })

// --- per-session record of which mode texts are already in context ---

const statePath = (sid) => path.join(STATE_DIR, `${String(sid).replace(/[^\w-]/g, "_")}.json`)
function readInjected(sid) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sid), "utf8"))
  } catch {
    return {}
  }
}
function writeInjected(sid, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(statePath(sid), JSON.stringify(state))
}

// --- SessionStart / SubagentStart: codebase memory snapshot ---

/** Overview, verified commands and feature list for the repo, or null when memory is off. */
function memorySnapshot(cwd) {
  const repo = repoKeyFor(cwd)
  if (!isEnabled(repo)) return null
  const entry = readStore().repos[repo]
  const features = Object.values(entry?.features ?? {}).map((f) => `- ${f.name} — ${f.description}`).join("\n")
  const recipes = entry?.content?.commandRecipes?.trim()
  return [
    `## Repository overview\n${entry?.content?.repositoryOverview?.trim() || "(none yet — seed it with the codebase-memory skill)"}`,
    ...(recipes ? [`## Verified commands\n${recipes}`] : []),
    `## Known features\n${features || "(none yet)"}`,
  ].join("\n\n")
}

function sessionStart(input) {
  // Fresh, cleared, or compacted context no longer holds the mode texts.
  if (input.source !== "resume") fs.rmSync(statePath(input.session_id), { force: true })
  const snapshot = memorySnapshot(input.cwd)
  if (!snapshot) return
  context(
    "SessionStart",
    [
      "DistilCode codebase memory is enabled for this repository.",
      snapshot,
      `Delegate localisation (finding where code lives) to the ${CODEX ? "explorer subagent" : "distilcode:explore agent"}; it reads this memory first. ` +
        "When you materially change where a feature lives (files, entrypoints, symbols, architecture), update it with modifyFeature; " +
        "add substantial new features with addFeature; remove deleted ones with removeFeature. Skip trivial changes.",
    ].join("\n\n"),
  )
}

/** The explore agent gets the CLI's memory workflow plus the snapshot (hooks match only distilcode:explore / Codex's explorer). */
function subagentStart(input) {
  const snapshot = memorySnapshot(input.cwd)
  if (!snapshot) return
  context("SubagentStart", ["# DistilCode codebase memory", prompt("explore-memory.md"), `Repository working directory (memory \`root\`): ${input.cwd}`, snapshot].join("\n\n"))
}

// --- UserPromptSubmit: toggle commands, then mode injection ---

// `/distilcode caveman off repo` (also `/distilcode:distilcode ...`), or bare `caveman on` (a bare word needs an argument).
const SLASH = /^\s*\/distilcode(?::distilcode)?((?:\s+\S+)*)\s*$/i
const BARE = /^\s*((?:ponytail|caveman)(?:\s+(?:on|off|toggle|status|session|once|repo|global|always)){1,2})\s*$/i
const STOP = /^\s*(?:stop (ponytail|caveman)|normal mode)\s*[.!]?\s*$/i

function userPromptSubmit(input) {
  const sid = input.session_id
  const ctx = { cwd: input.cwd, sessionID: sid }
  const text = String(input.prompt ?? "")

  // Handled here so a toggle costs no model turn; the slash commands are the fallback.
  const toggle = text.match(SLASH) ?? text.match(BARE)
  const stop = text.match(STOP)
  if (toggle || stop) {
    let lines
    try {
      lines = toggle
        ? modes.run({ ...ctx, args: toggle[1].trim().split(/\s+/).filter(Boolean) })
        : (stop[1] ? [stop[1].toLowerCase()] : modes.MODES).map((mode) => modes.command({ ...ctx, mode, args: ["off", "session"] }))
    } catch (e) {
      lines = [e.message]
    }
    return emit({ decision: "block", reason: lines.join("\n"), ...(CODEX ? {} : { suppressOriginalPrompt: true }) })
  }

  const active = modes.readModes(ctx)
  const injected = readInjected(sid)
  const parts = []
  for (const mode of modes.MODES) {
    if (active[mode] && !injected[mode]) parts.push(prompt(`${mode}.md`))
    else if (active[mode] && mode === "caveman") parts.push(prompt("caveman-reminder.md"))
    else if (!active[mode] && injected[mode]) parts.push(`${mode.toUpperCase()} MODE OFF — the user turned it off. Ignore the earlier ${mode} instructions.`)
  }
  writeInjected(sid, active)
  context("UserPromptSubmit", parts.join("\n\n"))
}

// --- PreToolUse(Bash|PowerShell): rtk rewrite, or PowerShell object capture ---
// --- PostToolUse(PowerShell): compact the captured objects ---

const RTK_BIN = process.platform === "win32" ? "rtk.exe" : "rtk"
const RTK_HOME = path.join(os.homedir(), ".distilcode", "bin")
const tokenKillerOff = () => process.env.DISTILCODE_NO_TOKEN_KILLER === "1"

/** Executable on PATH (PATHEXT-aware on Windows), like Bun.which. */
function which(name) {
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""]
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      const c = dir.trim() && path.join(dir.trim(), name + ext)
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c
    }
  }
  return null
}

/** Order matches the CLI (token-killer.ts): env override, rtk shipped beside an installed CLI, ~/.distilcode/bin, PATH. */
function resolveRtk() {
  if (tokenKillerOff()) return null
  const explicit = (process.env.DISTILCODE_RTK_BINARY ?? "").trim()
  if (explicit) return fs.existsSync(explicit) ? explicit : null
  // Release builds put rtk next to the real executable (inside the .app on macOS); the PATH entry is often a symlink.
  for (const cli of ["distilcode", "oxys"]) {
    const found = which(cli)
    if (!found) continue
    for (const exe of new Set([found, fs.realpathSync(found)])) {
      const sibling = path.join(path.dirname(exe), RTK_BIN)
      if (fs.existsSync(sibling)) return sibling
    }
  }
  const flat = path.join(RTK_HOME, RTK_BIN)
  if (fs.existsSync(flat)) return flat
  try {
    for (const e of fs.readdirSync(RTK_HOME, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
      const c = path.join(RTK_HOME, e.name, RTK_BIN)
      if (e.isDirectory() && e.name.startsWith("rtk-") && fs.existsSync(c)) return c
    }
  } catch {}
  return which("rtk")
}

/** First run: download rtk in the background (at most once per 10 minutes); this call passes through. */
function bootstrapRtk() {
  const lock = path.join(RTK_HOME, ".bootstrap")
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60_000) return
  } catch {}
  fs.mkdirSync(RTK_HOME, { recursive: true })
  fs.writeFileSync(lock, "")
  spawn(process.execPath, [path.join(PLUGIN_ROOT, "bin", "rtk"), "--version"], { detached: true, stdio: "ignore", windowsHide: true }).unref()
}

function rtkRewrite(rtk, command, cwd) {
  return new Promise((finish) => {
    let out = ""
    let child
    const timer = setTimeout(() => child?.kill(), 3000)
    const done = (v) => {
      clearTimeout(timer)
      finish(v)
    }
    try {
      child = spawn(rtk, ["rewrite", command], { cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
    } catch {
      return done(null)
    }
    child.stdout.on("data", (c) => {
      out += c
      if (out.length > 8192) child.kill()
    })
    child.on("error", () => done(null))
    child.on("close", (code) => done(code === 1 || !out.trim() ? null : out.trim()))
  })
}

// PowerShell aliases that shadow Unix tools (token-killer.ts). `rtk ls` execs an `ls` binary that stock
// Windows lacks, so the rewrite would fail where the alias works. `diff` is implemented by rtk itself.
const POWERSHELL_ALIASES = new Set([
  "ls", "dir", "cat", "type", "cp", "copy", "mv", "move", "rm", "del", "rmdir", "pwd", "echo",
  "sort", "diff", "sleep", "kill", "ps", "curl", "wget", "where", "tee", "cd", "man", "gc", "gci", "sls",
])
const RTK_NATIVE = new Set(["diff"])

function wrapsPowerShellAlias(rewritten) {
  return [...rewritten.matchAll(/(?:^|[;&|]\s*)rtk\s+(\S+)/g)].some((m) => {
    const name = m[1].toLowerCase()
    return POWERSHELL_ALIASES.has(name) && !RTK_NATIVE.has(name) && !which(name)
  })
}

async function preToolUse(input) {
  const command = input.tool_input?.command
  if (typeof command !== "string" || !command.trim() || tokenKillerOff()) return
  // CODEX: shell calls always report tool_name "Bash" but run in PowerShell on Windows.
  const powershell = input.tool_name === "PowerShell" || (CODEX && process.platform === "win32")
  const rtk = resolveRtk()
  if (!rtk && !process.env.DISTILCODE_RTK_BINARY?.trim()) bootstrapRtk()
  let rewritten = rtk ? await rtkRewrite(rtk, command, input.cwd) : null
  if (rewritten && powershell && wrapsPowerShellAlias(rewritten)) rewritten = null
  let next
  if (rewritten) {
    // Pin the binary we resolved; the shell's PATH may not contain it.
    const exe = powershell ? `& "${rtk}"` : `"${rtk.split(path.sep).join("/")}"`
    next = rewritten.replace(/(^|[;&|]\s*)rtk(?=\s|$)/g, (_m, p) => `${p}${exe}`)
  } else if (powershell && process.platform === "win32" && !CODEX) {
    // CODEX can't replace tool output (no updatedToolOutput), so the PostToolUse half can't run there.
    next = PowerShellShape.wrap(command)
  }
  if (!next || next === command) return
  // Claude: no permissionDecision, so the normal permission flow still applies.
  // CODEX: updatedInput is only accepted with "allow"; sandbox approvals still go through PermissionRequest.
  const decision = CODEX ? { permissionDecision: "allow" } : {}
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", ...decision, updatedInput: { ...input.tool_input, command: next } } })
}

// rtk nags "[rtk] /!\ No hook installed — run `rtk init -g`" on every call (shell.ts strips it too).
// PowerShell wraps native stderr in an error record, so drop its "At line:" / "+ ..." continuation lines as well.
const RTK_WARNING = /^.*\[rtk\] \/!\\[^\n]*\r?\n?(?:(?:At line:|\s*\+ )[^\n]*\r?\n?)*/gm
const stripRtkWarnings = (text) => (text.includes("[rtk] /!\\") ? text.replace(RTK_WARNING, "") : text)

function postToolUse(input) {
  const response = input.tool_response
  if (typeof response?.stdout !== "string") return
  let stdout = stripRtkWarnings(response.stdout)
  const stderr = typeof response.stderr === "string" ? stripRtkWarnings(response.stderr) : response.stderr
  if (input.tool_name === "PowerShell" && stdout.includes(PowerShellShape.MARK)) stdout = PowerShellShape.compact(stdout, input.cwd) ?? stdout
  if (stdout === response.stdout && stderr === response.stderr) return
  emit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { ...response, stdout, stderr } } })
}

// ---

const HANDLERS = {
  SessionStart: sessionStart,
  SubagentStart: subagentStart,
  UserPromptSubmit: userPromptSubmit,
  PreToolUse: preToolUse,
  PostToolUse: postToolUse,
}

let raw = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (c) => (raw += c))
process.stdin.on("end", async () => {
  try {
    await HANDLERS[process.argv[2]]?.(JSON.parse(raw))
  } catch {
    // Fail open.
  }
})
