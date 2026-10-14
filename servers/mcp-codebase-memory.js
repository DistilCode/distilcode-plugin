#!/usr/bin/env node
// MCP server for codebase memory (Claude-facing skin).
// Same JSON store + same six operations as the built-in tools, so memory is
// shared: <data>/codebase-memory.json ({version:1, repos}).
// Gating reads <data>/agent-behaviours.json per repoKey: tools are omitted
// from tools/list (fixed-root mode) and always re-checked on tools/call.
// Stdlib only: the stdio JSON-RPC transport is hand-rolled below so the plugin
// works straight from a git checkout with no `npm install`.
"use strict"

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

// Same resolution as xdg-basedir, which the CLI uses on every OS (core/src/global.ts).
const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")

const DATA_DIR = process.env.DISTILCODE_DATA_DIR ?? path.join(xdgData, "distilcode")
const memoryFile = () => process.env.OPENCODE_CODEBASE_MEMORY_PATH ?? path.join(DATA_DIR, "codebase-memory.json")
const behavioursFile = () => path.join(DATA_DIR, "agent-behaviours.json")

// Fixed repo scope: `node mcp-codebase-memory.js --root <dir>` (or MCP_MEMORY_ROOT).
// With it, tools/list is gated on that repo. Without it, tools always list and
// each call is gated on its `root` param.
const FIXED_ROOT = (() => {
  const i = process.argv.indexOf("--root")
  const raw = i === -1 ? process.env.MCP_MEMORY_ROOT : process.argv[i + 1]
  return raw ? path.resolve(raw) : null
})()

// --- store (mirrors core/src/codebase-memory.ts; JSON shape shared verbatim) ---

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(memoryFile(), "utf8"))
    if (parsed?.version !== 1 || !parsed.repos) throw new Error("invalid store")
    return parsed
  } catch (e) {
    if (e?.code === "ENOENT") return { version: 1, repos: {} }
    throw e
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(memoryFile()), { recursive: true })
  const tmp = `${memoryFile()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n")
  fs.renameSync(tmp, memoryFile())
}

function repoKeyFor(root) {
  try {
    return fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim())
  } catch {}
  try {
    return fs.realpathSync(path.resolve(root))
  } catch {
    return path.resolve(root)
  }
}

function isEnabled(repo) {
  try {
    const parsed = JSON.parse(fs.readFileSync(behavioursFile(), "utf8"))
    if (parsed?.version !== 1) return false
    const entry = parsed.repos?.[repo] ?? {}
    return entry.codebaseMemory ?? entry.sticky ?? parsed.global?.codebaseMemory ?? parsed.global?.sticky ?? false
  } catch {
    return false
  }
}

function normalizeName(name) {
  const n = String(name ?? "").trim().replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  if (!n) throw new Error("Feature name must be non-empty")
  return n
}

function requireInside(root, absolute) {
  const rel = path.relative(root, absolute)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Feature path is outside the repository: ${absolute}`)
}

function requireMemory(store, repo) {
  const entry = store.repos[repo]
  if (!entry?.root) throw new Error("Codebase memory has not been initialized")
  return entry
}

function canonicalPaths(root, cwd, feature) {
  const one = (value) => {
    if (!String(value).trim() || value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error(`Feature path must be relative: ${value}`)
    const absolute = path.resolve(cwd, value)
    requireInside(root, absolute)
    requireInside(root, fs.realpathSync(absolute))
    if (!fs.statSync(absolute).isFile()) throw new Error(`Feature path must refer to a file: ${value}`)
    return path.relative(root, absolute).split(path.sep).join("/")
  }
  return {
    ...(feature.files !== undefined ? { files: feature.files.map(one) } : {}),
    ...(feature.entrypoints !== undefined ? { entrypoints: feature.entrypoints.map(one) } : {}),
  }
}

function initialize(store, repo, root) {
  const prev = store.repos[repo]
  if (prev?.root) return prev
  const entry = { ...prev, root: fs.realpathSync(root), features: prev?.features ?? {}, status: prev?.status ?? "creating" }
  store.repos[repo] = entry
  return entry
}

function doRepoOverview(store, repo, overview) {
  if (!String(overview ?? "").trim()) throw new Error("Repository overview must be non-empty")
  const entry = requireMemory(store, repo)
  store.repos[repo] = { ...entry, updatedAt: Date.now(), content: { moduleSummaries: "", featureMapping: "", commandRecipes: "", ...entry.content, repositoryOverview: overview.trim() } }
  return "Repository overview saved"
}

function doAddFeature(store, repo, cwd, f) {
  const entry = requireMemory(store, repo)
  const name = normalizeName(f.name)
  if (Object.hasOwn(entry.features ?? {}, name)) throw new Error(`Feature already exists: ${name}`)
  if (!String(f.description ?? "").trim()) throw new Error("Feature description must be non-empty")
  store.repos[repo] = { ...entry, updatedAt: Date.now(), features: { ...entry.features, [name]: { ...f, name, ...canonicalPaths(entry.root, cwd, f) } } }
  return doGetFeature(store, repo, cwd, name)
}

function doModifyFeature(store, repo, cwd, update) {
  const entry = requireMemory(store, repo)
  const name = normalizeName(update.name)
  const prev = Object.hasOwn(entry.features ?? {}, name) ? entry.features[name] : undefined
  if (!prev) throw new Error(`Feature does not exist: ${name}`)
  if (update.description !== undefined && !String(update.description).trim()) throw new Error("Feature description must be non-empty")
  const supplied = Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined))
  store.repos[repo] = { ...entry, updatedAt: Date.now(), features: { ...entry.features, [name]: { ...prev, ...supplied, name, ...canonicalPaths(entry.root, cwd, update) } } }
  return doGetFeature(store, repo, cwd, name)
}

function doRemoveFeature(store, repo, name) {
  const entry = requireMemory(store, repo)
  const canonical = normalizeName(name)
  if (!Object.hasOwn(entry.features ?? {}, canonical)) return { name: canonical, removed: false }
  store.repos[repo] = { ...entry, updatedAt: Date.now(), features: Object.fromEntries(Object.entries(entry.features ?? {}).filter(([k]) => k !== canonical)) }
  return { name: canonical, removed: true }
}

function doGetFeature(store, repo, cwd, name) {
  const entry = requireMemory(store, repo)
  const canonical = normalizeName(name)
  const feature = Object.hasOwn(entry.features ?? {}, canonical) ? entry.features[canonical] : undefined
  if (!feature) throw new Error(`Feature does not exist: ${canonical}`)
  const translate = (value) => {
    const absolute = path.resolve(entry.root, value)
    requireInside(entry.root, absolute)
    return path.relative(cwd, absolute)
  }
  return { ...feature, files: feature.files.map(translate), entrypoints: feature.entrypoints.map(translate) }
}

function doListFeatures(store, repo) {
  return Object.values(store.repos[repo]?.features ?? {}).map((f) => `${f.name} — ${f.description}`).join("\n")
}

// --- MCP surface ---

const str = { type: "string" }
const strArr = { type: "array", items: { type: "string" } }
const rootProp = FIXED_ROOT ? {} : { root: { ...str, description: "Repository working directory (caller's cwd)" } }

const TOOLS = [
  { name: "repoOverview", description: "Persist the repository overview. The overview must be non-empty.", inputSchema: { type: "object", properties: { ...rootProp, overview: str }, required: FIXED_ROOT ? ["overview"] : ["root", "overview"] } },
  { name: "addFeature", description: "Persist a meaningful feature's navigation information. Paths must refer to repository files relative to your working directory. Rejects duplicate names.", inputSchema: { type: "object", properties: { ...rootProp, name: str, description: str, entrypoints: strArr, files: strArr, symbols: strArr, notes: strArr }, required: FIXED_ROOT ? ["name", "description", "entrypoints", "files", "symbols", "notes"] : ["root", "name", "description", "entrypoints", "files", "symbols", "notes"] } },
  { name: "modifyFeature", description: "Update only supplied feature fields; arrays replace existing arrays. Provide paths relative to your working directory.", inputSchema: { type: "object", properties: { ...rootProp, name: str, description: str, entrypoints: strArr, files: strArr, symbols: strArr, notes: strArr }, required: FIXED_ROOT ? ["name"] : ["root", "name"] } },
  { name: "removeFeature", description: "Remove an invalid, duplicated, or deleted feature. Reports whether it existed.", inputSchema: { type: "object", properties: { ...rootProp, name: str }, required: FIXED_ROOT ? ["name"] : ["root", "name"] } },
  { name: "getFeature", description: "Retrieve a complete feature's navigation information. Returned paths are relative to your working directory; verify against source before using.", inputSchema: { type: "object", properties: { ...rootProp, name: str }, required: FIXED_ROOT ? ["name"] : ["root", "name"] } },
  { name: "listFeatures", description: "List known feature names and short descriptions only.", inputSchema: { type: "object", properties: { ...rootProp }, required: FIXED_ROOT ? [] : ["root"] } },
]

function resolveCall(args) {
  const root = FIXED_ROOT ?? args?.root
  if (!root || typeof root !== "string") throw new Error("`root` (repository working directory) is required")
  const repo = repoKeyFor(root)
  if (!isEnabled(repo)) throw new Error(`Codebase memory is disabled for this repository: ${repo}`)
  const store = readStore()
  initialize(store, repo, root)
  return { store, repo, cwd: path.resolve(root) }
}

function runTool(name, rawArgs) {
  const { store, repo, cwd } = resolveCall(rawArgs ?? {})
  // `root` addresses the repo; it must not be persisted into feature records.
  const { root: _root, ...args } = rawArgs ?? {}
  let out
  if (name === "repoOverview") out = doRepoOverview(store, repo, args.overview)
  else if (name === "addFeature") out = doAddFeature(store, repo, cwd, args)
  else if (name === "modifyFeature") out = doModifyFeature(store, repo, cwd, args)
  else if (name === "removeFeature") out = doRemoveFeature(store, repo, args.name)
  else if (name === "getFeature") out = doGetFeature(store, repo, cwd, args.name)
  else if (name === "listFeatures") out = doListFeatures(store, repo)
  else throw new Error(`Unknown tool: ${name}`)
  writeStore(store)
  return typeof out === "string" ? out : JSON.stringify(out, null, 2)
}

// --- stdio transport: newline-delimited JSON-RPC 2.0 (MCP stdio framing) ---

function handle(msg) {
  const { id, method, params } = msg
  if (id === undefined) return null // notification
  const reply = (result) => ({ jsonrpc: "2.0", id, result })
  if (method === "initialize")
    return reply({ protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "codebase-memory", version: "1.1.0" } })
  if (method === "ping") return reply({})
  if (method === "tools/list") return reply({ tools: FIXED_ROOT && !isEnabled(repoKeyFor(FIXED_ROOT)) ? [] : TOOLS })
  if (method === "tools/call") {
    try {
      return reply({ content: [{ type: "text", text: runTool(params?.name, params?.arguments) }] })
    } catch (e) {
      return reply({ content: [{ type: "text", text: e?.message ?? String(e) }], isError: true })
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }
}

function main() {
  let buf = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let out
      try {
        out = handle(JSON.parse(line))
      } catch {
        out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
      }
      if (out) process.stdout.write(JSON.stringify(out) + "\n")
    }
  })
}

module.exports = { runTool, isEnabled, repoKeyFor, readStore, TOOLS, DATA_DIR, behavioursFile }
if (require.main === module) main()
