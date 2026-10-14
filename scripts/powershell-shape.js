// Port of the CLI's tool/shell/powershell-shape.ts (keep the two in sync).
//
// rtk cannot help with PowerShell listing/search/process cmdlets on Windows:
// `rtk ls` / `rtk ps` exec Unix binaries stock Windows lacks, and Select-String
// has no rtk equivalent. PowerShell's default formatting also pads piped output
// to 120 columns and wraps or cuts long values.
//
// `wrap` (PreToolUse) runs the command unchanged but captures its objects and
// prints their raw fields between markers. `compact` (PostToolUse) turns those
// fields into the grep/glob tool shapes. Any other output keeps PowerShell's
// normal formatting.
"use strict"

const path = require("node:path")

const MARK = "\u001edistilcode-ps"
const HEADS = new Set(["ls", "dir", "gci", "get-childitem", "sls", "select-string", "ps", "gps", "get-process"])
const LISTING_HEADS = new Set(["ls", "dir", "gci", "get-childitem"])
const SEARCH_HEADS = new Set(["sls", "select-string"])
const FORMATTERS = /\b(?:Format-\w+|Out-\w+|ConvertTo-\w+|Export-\w+|Tee-Object|Set-Content|Add-Content|Write-Host)\b/i
const DROPPED_FIELDS =
  /\b(?:LastWriteTime\w*|CreationTime\w*|LastAccessTime\w*|Attributes|Mode|Handles?|NPM|PM|VM|SI|StartTime|Threads|Modules|PrivateMemorySize\w*|PagedMemorySize\w*|NonpagedSystemMemorySize\w*)\b/i
const MAX_LINE_CHARS = 2000

const stageHead = (stage) => stage.trim().split(/\s+/)[0]?.toLowerCase() ?? ""

/** Wrap a single PowerShell pipeline so its output can be compacted, or undefined to run it untouched. */
function wrap(command) {
  const trimmed = command.trim()
  if (!trimmed || /[;\n\r`]|&&|\|\||--%|\$__dc/.test(trimmed)) return undefined
  if (FORMATTERS.test(trimmed)) return undefined
  const stages = trimmed.split("|")
  const heads = stages.map(stageHead)
  if (!heads.some((h) => HEADS.has(h))) return undefined
  if (stages.some((s) => !SEARCH_HEADS.has(stageHead(s)) && DROPPED_FIELDS.test(s))) return undefined
  const paths = LISTING_HEADS.has(heads[0] ?? "") ? "$true" : "$false"
  return [
    "$__dcErr = $Error.Count",
    "$global:LASTEXITCODE = 0",
    `$__dcOut = @(${trimmed})`,
    "$__dcFailed = $Error.Count -gt $__dcErr -or $LASTEXITCODE -ne 0",
    "$__dcKind = ''",
    "if ($__dcOut.Count -gt 0) {",
    "  if (-not ($__dcOut | Where-Object { $_ -isnot [System.IO.FileSystemInfo] })) { $__dcKind = 'ls' }",
    "  elseif (-not ($__dcOut | Where-Object { $_.GetType().FullName -ne 'Microsoft.PowerShell.Commands.MatchInfo' -or $_.Path -eq 'InputStream' })) { $__dcKind = 'sls' }",
    "  elseif (-not ($__dcOut | Where-Object { $_ -isnot [System.Diagnostics.Process] })) { $__dcKind = 'ps' }",
    `  elseif (${paths} -and -not ($__dcOut | Where-Object { $_ -isnot [string] })) { $__dcKind = 'paths' }`,
    "}",
    "if (-not $__dcKind) { $__dcOut } else {",
    `  "${MARK} $__dcKind $(($__dcOut | Out-String).Length)"`,
    "  switch ($__dcKind) {",
    "    'ls' { foreach ($i in $__dcOut) { if ($i.PSIsContainer) { \"d`t`t$($i.FullName)\" } else { \"f`t$($i.Length)`t$($i.FullName)\" } } }",
    "    'sls' { foreach ($m in $__dcOut) {",
    "      $n = $m.LineNumber",
    "      if ($m.Context) { $k = $n - $m.Context.PreContext.Count; foreach ($l in $m.Context.PreContext) { \"c`t$k`t$($m.Path)`t$l\"; $k++ } }",
    "      \"m`t$n`t$($m.Path)`t$($m.Line)\"",
    "      if ($m.Context) { $k = $n + 1; foreach ($l in $m.Context.PostContext) { \"c`t$k`t$($m.Path)`t$l\"; $k++ } }",
    "    } }",
    "    'ps' { foreach ($p in $__dcOut) { \"$($p.Id)`t$([math]::Round([double]$p.CPU, 2))`t$($p.WorkingSet64)`t$($p.ProcessName)\" } }",
    "    'paths' { $__dcOut }",
    "  }",
    `  "${MARK} end"`,
    "}",
    "if ($__dcFailed) { exit 1 }",
  ].join("\n")
}

/** Replace the marked block with its compact form; text outside it is kept. Undefined without a complete block. */
function compact(output, cwd) {
  const lines = output.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith(`${MARK} `) && l !== `${MARK} end`)
  const end = lines.findIndex((l, i) => i > start && l === `${MARK} end`)
  if (start === -1 || end === -1) return undefined
  const [, kind] = lines[start].split(" ")
  const body = lines.slice(start + 1, end)
  const formatted =
    kind === "ls" ? formatListing(body, cwd)
    : kind === "sls" ? formatMatches(body, cwd)
    : kind === "ps" ? formatProcesses(body)
    : kind === "paths" ? formatGlob(body.filter(Boolean))
    : undefined
  if (formatted === undefined) return undefined
  const before = lines.slice(0, start).join("\n").trim()
  const after = lines.slice(end + 1).join("\n").trim()
  return [before, formatted, after].filter(Boolean).join("\n\n")
}

function splitFields(line, count) {
  const fields = line.split("\t")
  return [...fields.slice(0, count - 1), fields.slice(count - 1).join("\t")]
}

const normalize = (v) => v.replaceAll("\\", "/")
const truncateLine = (t) => (t.length <= MAX_LINE_CHARS ? t : t.slice(0, MAX_LINE_CHARS).replace(/[\uD800-\uDBFF]$/, "") + "...")

function fromCwd(cwd, file) {
  const root = normalize(cwd).replace(/\/+$/, "")
  const p = normalize(file)
  const fold = (v) => (process.platform === "win32" ? v.toLowerCase() : v)
  if (fold(p) === fold(root)) return "."
  return fold(p).startsWith(fold(root) + "/") ? p.slice(root.length + 1) : p
}

function parent(file) {
  const i = file.lastIndexOf("/")
  return i === -1 ? "" : file.slice(0, i)
}

function commonDir(dirs) {
  return dirs.reduce((base, dir) => {
    while (base && dir !== base && !dir.startsWith(base + "/")) base = parent(base)
    return base
  })
}

function relative(base, file) {
  if (!base) return file
  if (file === base) return "."
  return file.startsWith(base + "/") ? file.slice(base.length + 1) : file
}

function size(bytes) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${bytes}B`
}

function groupBy(items, key) {
  const map = new Map()
  for (const item of items) {
    const k = key(item)
    map.set(k, [...(map.get(k) ?? []), item])
  }
  return map
}

function formatListing(body, cwd) {
  const entries = body
    .filter(Boolean)
    .map((l) => splitFields(l, 3))
    .map(([type, bytes, full]) => ({ dir: type === "d", bytes: Number(bytes), path: fromCwd(cwd, full ?? "") }))
  if (entries.length === 0) return ""
  const groups = groupBy(entries, (e) => parent(e.path))
  const base = commonDir([...groups.keys()])
  const out = base ? [`base=${base}`] : []
  for (const [dir, items] of groups) {
    const root = dir === base
    if (!root) out.push(`${relative(base, dir)}/`)
    const indent = root ? "" : "  "
    for (const item of items) {
      const name = item.path.slice(dir.length + (dir ? 1 : 0))
      out.push(item.dir ? `${indent}${name}/` : `${indent}${name}  ${size(item.bytes)}`)
    }
  }
  return out.join("\n")
}

function formatMatches(body, cwd) {
  const rows = body
    .filter(Boolean)
    .map((l) => splitFields(l, 4))
    .map(([type, line, file, text]) => ({ match: type === "m", line, path: fromCwd(cwd, file ?? ""), text: text ?? "" }))
  const total = rows.filter((r) => r.match).length
  const groups = groupBy(rows, (r) => r.path)
  const base = commonDir([...groups.keys()].map(parent))
  const out = [`Found ${total} matches`]
  if (base) out.push(`base=${base}`)
  for (const [file, items] of groups) {
    out.push("", relative(base, file))
    for (const item of items) out.push(`${item.line}${item.match ? " " : "-"} ${truncateLine(item.text)}`)
  }
  return out.join("\n")
}

function formatProcesses(body) {
  const rows = body
    .filter(Boolean)
    .map((l) => splitFields(l, 4))
    .map(([id, cpu, memory, name]) => ({ id, cpu: Number(cpu) || 0, memory: Number(memory) || 0, name: name ?? "" }))
  return [...groupBy(rows, (r) => r.name)]
    .map(([name, items]) => {
      const cpu = items.reduce((s, i) => s + i.cpu, 0)
      const memory = items.reduce((s, i) => s + i.memory, 0)
      const ids = items.map((i) => i.id).join(",")
      const label = items.length > 1 ? `${name} x${items.length}  ids=${ids}` : `${name}  id=${ids}`
      return `${label}  cpu=${Number(cpu.toFixed(2))}s  mem=${size(memory)}`
    })
    .join("\n")
}

// --- glob shape (output.ts formatGlobOutput / collapseNames) ---

function commonBaseDir(paths) {
  if (paths.length === 0) return ""
  let base = path.dirname(paths[0])
  for (const p of paths.slice(1)) {
    const dir = path.dirname(p)
    while (base && dir !== base && !dir.startsWith(base + path.sep)) {
      const up = path.dirname(base)
      if (up === base) break
      base = up
    }
  }
  return base
}

function collapseNames(names) {
  if (names.length < 2 || names.some((n) => /[{},]/.test(n))) return undefined
  let prefix = names[0]
  for (const n of names.slice(1)) while (prefix && !n.startsWith(prefix)) prefix = prefix.slice(0, -1)
  if (prefix && !/[.-]$/.test(prefix)) prefix = ""
  let suffix = names[0]
  for (const n of names.slice(1)) while (suffix && !n.endsWith(suffix)) suffix = suffix.slice(1)
  const dot = suffix.indexOf(".")
  suffix = dot === -1 ? "" : suffix.slice(dot)
  const stems = names.map((n) => n.slice(prefix.length, n.length - suffix.length))
  if (stems.some((s) => s === "")) return undefined
  return `${prefix}{${stems.join(",")}}${suffix}`
}

function formatGlob(files) {
  if (files.length === 0) return "No files found"
  const out = []
  const base = commonBaseDir(files)
  if (base) out.push(`base=${base}`)
  const byDir = new Map()
  for (const f of files) {
    const rel = normalize(base ? path.relative(base, f) : f)
    const i = rel.lastIndexOf("/")
    const dir = i === -1 ? "" : rel.slice(0, i)
    byDir.set(dir, [...(byDir.get(dir) ?? []), i === -1 ? rel : rel.slice(i + 1)])
  }
  for (const dir of [...byDir.keys()].sort()) {
    const names = byDir.get(dir).sort()
    const prefix = dir ? `${dir}/` : ""
    const plain = names.map((n) => `${prefix}${n}`)
    const collapsed = collapseNames(names)
    if (collapsed && `${prefix}${collapsed}`.length < plain.join("\n").length) out.push(`${prefix}${collapsed}`)
    else out.push(...plain)
  }
  return out.join("\n")
}

module.exports = { wrap, compact, MARK }
