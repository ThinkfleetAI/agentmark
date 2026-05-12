/**
 * OS-native process enumeration + introspection.
 *
 * Cross-platform via shell-out to OS-shipped tools (no Node deps):
 *   - macOS / Linux: `ps` with format-string output
 *   - Windows:       PowerShell `Get-Process` + WMI `Win32_Process` for cmdline
 *
 * Output is normalised to a uniform `ProcessSummary` / `ProcessDetail`
 * shape regardless of platform so the agent can write platform-agnostic
 * logic.
 */
import { spawn } from 'node:child_process'

export interface ProcessSummary {
    pid: number
    /** Process name / image name. Just the basename, no path. */
    name: string
    /** Username running the process (when available). */
    user?: string
    /** CPU percentage (sample-based on POSIX; instantaneous on Win). */
    cpu_percent?: number
    /** Memory percentage of total system RAM. */
    memory_percent?: number
    /** Resident set size in KB (memory in physical RAM). */
    memory_kb?: number
    /** Elapsed time since the process started (formatted string like "01:02:03"). */
    elapsed?: string
    /** Best-effort full command line. May be truncated by the OS. */
    command?: string
}

export interface ProcessDetail extends ProcessSummary {
    ppid?: number
    /** OS-specific status flag (ps: STAT column; Win: ProcessName). */
    state?: string
    /** Virtual memory size in KB. */
    vsz_kb?: number
}

export async function listProcesses(): Promise<ProcessSummary[]> {
    if (process.platform === 'win32') {
        return await listProcessesWindows()
    }
    return await listProcessesPosix()
}

export async function getProcessDetail(pid: number): Promise<ProcessDetail | null> {
    if (process.platform === 'win32') {
        return await getDetailWindows(pid)
    }
    return await getDetailPosix(pid)
}

// ──────────────────────────────────────────────────────────────────────
// macOS / Linux — `ps`
// ──────────────────────────────────────────────────────────────────────

async function listProcessesPosix(): Promise<ProcessSummary[]> {
    // `ps` formatting:
    //   pid  pcpu pmem user etime rss command (last is rest-of-line)
    // -A   = all processes
    // -ww  = no truncation
    const out = await runForStdout('ps', ['-Aww', '-o', 'pid=,pcpu=,pmem=,user=,etime=,rss=,comm='])
    return parsePsLines(out, parsePsLine)
}

async function getDetailPosix(pid: number): Promise<ProcessDetail | null> {
    try {
        const out = await runForStdout('ps', ['-p', String(pid), '-ww', '-o', 'pid=,ppid=,pcpu=,pmem=,user=,etime=,vsz=,rss=,stat=,command='])
        const lines = out.split(/\r?\n/).filter(Boolean)
        if (lines.length === 0) return null
        return parsePsDetailLine(lines[0])
    } catch {
        return null
    }
}

function parsePsLines<T>(out: string, lineParser: (line: string) => T | null): T[] {
    const result: T[] = []
    for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue
        const parsed = lineParser(line)
        if (parsed) result.push(parsed)
    }
    return result
}

function parsePsLine(line: string): ProcessSummary | null {
    // Fields are space-separated; command is the last field and may
    // contain spaces. Split with limit-7 by taking first 6 tokens then
    // the remainder.
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/)
    if (!m) return null
    return {
        pid: parseInt(m[1], 10),
        cpu_percent: numericOrUndef(m[2]),
        memory_percent: numericOrUndef(m[3]),
        user: m[4],
        elapsed: m[5],
        memory_kb: parseInt(m[6], 10),
        command: m[7].trim(),
        name: basename(m[7].trim()),
    }
}

function parsePsDetailLine(line: string): ProcessDetail | null {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!m) return null
    const command = m[10].trim()
    return {
        pid: parseInt(m[1], 10),
        ppid: parseInt(m[2], 10),
        cpu_percent: numericOrUndef(m[3]),
        memory_percent: numericOrUndef(m[4]),
        user: m[5],
        elapsed: m[6],
        vsz_kb: parseInt(m[7], 10),
        memory_kb: parseInt(m[8], 10),
        state: m[9],
        command,
        name: basename(command),
    }
}

// ──────────────────────────────────────────────────────────────────────
// Windows — PowerShell
// ──────────────────────────────────────────────────────────────────────

async function listProcessesWindows(): Promise<ProcessSummary[]> {
    // PowerShell emits an array of objects as JSON; we read that back.
    const script = `Get-Process | Select-Object Id,ProcessName,@{n='CPU';e={[math]::Round($_.CPU,2)}},@{n='WS_KB';e={[math]::Round($_.WorkingSet64/1024,0)}},@{n='UserName';e={try{$_.UserName}catch{$null}}} | ConvertTo-Json -Depth 1 -Compress`
    const out = await runForStdout('powershell', ['-NoProfile', '-Command', script])
    return parseWinJsonList(out, false) as ProcessSummary[]
}

async function getDetailWindows(pid: number): Promise<ProcessDetail | null> {
    const script = `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object Id,@{n='PPid';e={(Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).ParentProcessId}},ProcessName,@{n='CPU';e={[math]::Round($_.CPU,2)}},@{n='WS_KB';e={[math]::Round($_.WorkingSet64/1024,0)}},@{n='VSZ_KB';e={[math]::Round($_.VirtualMemorySize64/1024,0)}},@{n='UserName';e={try{$_.UserName}catch{$null}}},@{n='CmdLine';e={(Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine}} | ConvertTo-Json -Depth 1 -Compress`
    const out = await runForStdout('powershell', ['-NoProfile', '-Command', script])
    const parsed = parseWinJsonList(out, true) as ProcessDetail[]
    return parsed[0] ?? null
}

interface WinRecord {
    Id: number
    ProcessName: string
    CPU?: number
    WS_KB?: number
    VSZ_KB?: number
    UserName?: string
    PPid?: number
    CmdLine?: string
}

function parseWinJsonList(out: string, detail: boolean): ProcessSummary[] | ProcessDetail[] {
    const trimmed = out.trim()
    if (!trimmed) return []
    let parsed: WinRecord[]
    try {
        const j = JSON.parse(trimmed) as unknown
        parsed = Array.isArray(j) ? (j as WinRecord[]) : [j as WinRecord]
    } catch {
        return []
    }
    return parsed.map((r) => {
        const base: ProcessSummary = {
            pid: r.Id,
            name: r.ProcessName,
            user: r.UserName ?? undefined,
            cpu_percent: r.CPU ?? undefined,
            memory_kb: r.WS_KB ?? undefined,
        }
        if (!detail) return base
        const det: ProcessDetail = {
            ...base,
            ppid: r.PPid ?? undefined,
            vsz_kb: r.VSZ_KB ?? undefined,
            command: r.CmdLine ?? undefined,
        }
        return det
    })
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function runForStdout(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
        child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0 || stdout.length > 0) {
                // ps returns 1 if some pids weren't found but others were
                // — accept any case where we got data.
                resolve(stdout)
            } else {
                reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
            }
        })
    })
}

function basename(commandLine: string): string {
    // Strip args, then strip directory components from argv[0].
    const argv0 = commandLine.split(/\s/, 1)[0] ?? ''
    const lastSlash = Math.max(argv0.lastIndexOf('/'), argv0.lastIndexOf('\\'))
    return lastSlash >= 0 ? argv0.slice(lastSlash + 1) : argv0
}

function numericOrUndef(s: string): number | undefined {
    const n = parseFloat(s)
    return Number.isFinite(n) ? n : undefined
}
