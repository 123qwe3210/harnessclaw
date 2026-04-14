import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  APP_LOG_PATH,
  DIAGNOSTIC_DIR,
  EXPORTS_DIR,
  LOGS_DIR,
  RENDERER_LOG_PATH,
  USAGE_LOG_PATH,
} from './runtime-paths'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type LogThreshold = 'fatal' | 'error' | 'info' | 'debug'
export type LogFileKind = 'app' | 'renderer'
export type DiagnosticDomain =
  | 'app.lifecycle'
  | 'config'
  | 'runtime.nanobot'
  | 'runtime.gateway'
  | 'runtime.harnessclaw'
  | 'runtime.clawhub'
  | 'comm.websocket'
  | 'chat'
  | 'doctor'
  | 'storage.db'
  | 'storage.files'
  | 'ui'
  | 'ipc'

export interface AvailableLogDomain {
  value: DiagnosticDomain
  count: number
}

export interface RuntimeLogEntry {
  cursor: string
  timestamp: number
  isoTime: string
  level: LogLevel
  source: string
  message: string
  metaText: string
  meta: Record<string, unknown> | null
  domain?: DiagnosticDomain
  action?: string
  file: LogFileKind
  raw: string
}

export interface GetLogsOptions {
  after?: string
  level?: LogThreshold
  exactLevel?: 'all' | LogLevel
  domain?: DiagnosticDomain | 'all'
  query?: string
  file?: 'all' | LogFileKind
  limit?: number
}

export interface GetLogsResult {
  items: RuntimeLogEntry[]
  cursor: string | null
  logDir: string
}

export interface UsageLogEntry {
  category: string
  action: string
  status: string
  details?: Record<string, unknown>
  sessionId?: string
  createdAt?: number
}

export interface DiagnosticEvent {
  ts: string
  level: LogLevel
  domain: DiagnosticDomain
  action: string
  status: string
  summary: string
  runId: string
  source: string
  requestId?: string
  sessionId?: string
  errorCode?: string
  durationMs?: number
  details: Record<string, unknown>
}

export interface DiagnosticEventRecord extends DiagnosticEvent {
  cursor: string
  timestamp: number
}

export interface GetDiagnosticEventsOptions {
  after?: string
  level?: LogThreshold
  exactLevel?: 'all' | LogLevel
  domain?: DiagnosticDomain | 'all'
  status?: string
  query?: string
  sessionId?: string
  requestId?: string
  limit?: number
}

export interface GetDiagnosticEventsResult {
  items: DiagnosticEventRecord[]
  cursor: string | null
  logDir: string
}

export interface UserSummaryItem {
  id: string
  level: LogLevel
  domain: DiagnosticDomain
  title: string
  status: string
  isNormal: boolean
  currentStatus: string
  impact: string
  suggestion: string
  timestamp: number
  isoTime: string
}

export interface GetDiagnosticSummaryResult {
  items: UserSummaryItem[]
}

interface DiagnosticRecordOptions {
  level: LogLevel
  domain: DiagnosticDomain
  action: string
  status: string
  summary: string
  source: string
  requestId?: string
  sessionId?: string
  errorCode?: string
  durationMs?: number
  details?: Record<string, unknown>
  projectTo?: LogFileKind
}

interface FailureRecordOptions {
  domain: DiagnosticDomain
  action: string
  summary: string
  source: string
  reason: string
  impact: string
  suggestion: string
  requestId?: string
  sessionId?: string
  errorCode?: string
  durationMs?: number
  details?: Record<string, unknown>
  fatal?: boolean
  projectTo?: LogFileKind
}

interface RetryRecordOptions {
  domain: DiagnosticDomain
  action: string
  summary: string
  source: string
  retryInMs: number
  reason: string
  impact?: string
  suggestion?: string
  requestId?: string
  sessionId?: string
  errorCode?: string
  details?: Record<string, unknown>
  projectTo?: LogFileKind
}

const DIAGNOSTIC_DOMAIN_ORDER: DiagnosticDomain[] = [
  'app.lifecycle',
  'config',
  'runtime.nanobot',
  'runtime.gateway',
  'runtime.harnessclaw',
  'runtime.clawhub',
  'comm.websocket',
  'chat',
  'doctor',
  'storage.db',
  'storage.files',
  'ui',
  'ipc',
]

const DOMAIN_SET = new Set<DiagnosticDomain>(DIAGNOSTIC_DOMAIN_ORDER)

const SENSITIVE_KEY_PATTERN = /(api[-_]?key|token|authorization|secret|password)/i
const TOOL_PARAM_KEY_PATTERN = /(tool_?input|input|payload|params|arguments|command)/i
const PREVIEW_MAX = 120
const currentRunId = randomUUID()

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

const LOG_THRESHOLD_ORDER: Record<LogThreshold, number> = {
  fatal: LOG_LEVEL_ORDER.fatal,
  error: LOG_LEVEL_ORDER.error,
  info: LOG_LEVEL_ORDER.info,
  debug: LOG_LEVEL_ORDER.debug,
}

let currentLogThreshold: LogThreshold = 'info'

const APP_LOG_PATTERN = /^\[(?<isoTime>[^\]]+)\] \[(?<level>[A-Z]+)\] \[(?<source>[^\]]+)\] (?<body>.*)$/
const RENDERER_LOG_PATTERN = /^\[(?<isoTime>[^\]]+)\] \[(?<level>[A-Z]+)\] (?<body>.*)$/

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function ensureParent(path: string): void {
  ensureDir(dirname(path))
}

function appendLine(path: string, line: string): void {
  ensureParent(path)
  appendFileSync(path, `${line}\n`, 'utf-8')
}

function getDiagnosticFilePath(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10)
  return join(DIAGNOSTIC_DIR, `events-${stamp}.jsonl`)
}

function truncateString(value: string, maxLength = PREVIEW_MAX): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}...`
}

function summarizeObject(value: Record<string, unknown>): Record<string, unknown> {
  return {
    fieldNames: Object.keys(value),
    fieldCount: Object.keys(value).length,
    redacted: true,
  }
}

function sanitizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: truncateString(error.message, 240),
    }
  }
  return { message: truncateString(String(error), 240) }
}

function sanitizeValue(value: unknown, keyHint = ''): unknown {
  if (value == null) return value

  if (SENSITIVE_KEY_PATTERN.test(keyHint)) {
    if (typeof value === 'string') {
      return {
        redacted: true,
        length: value.length,
        preview: truncateString(value.slice(0, 3), 8),
      }
    }
    return { redacted: true, type: typeof value }
  }

  if (value instanceof Error) {
    return sanitizeError(value)
  }

  if (typeof value === 'string') {
    return value.length > 240
      ? { length: value.length, preview: truncateString(value, PREVIEW_MAX), truncated: true }
      : value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    return {
      length: value.length,
      preview: value.slice(0, 5).map((item) => sanitizeValue(item)),
      truncated: value.length > 5,
    }
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>
    if (TOOL_PARAM_KEY_PATTERN.test(keyHint)) {
      return summarizeObject(objectValue)
    }

    return Object.fromEntries(
      Object.entries(objectValue).map(([key, child]) => [key, sanitizeValue(child, key)])
    )
  }

  return String(value)
}

export function sanitizeDiagnosticDetails<T>(value: T): T {
  return sanitizeValue(value) as T
}

function serializeMeta(meta?: unknown): string {
  if (meta == null) return ''
  try {
    return JSON.stringify(sanitizeDiagnosticDetails(meta))
  } catch {
    return JSON.stringify({ value: String(meta) })
  }
}

function normalizeLogLevel(value: string): LogLevel {
  const lowered = value.toLowerCase()
  if (lowered === 'debug' || lowered === 'info' || lowered === 'warn' || lowered === 'error' || lowered === 'fatal') {
    return lowered
  }
  return 'info'
}

export function normalizeLogThreshold(value: unknown): LogThreshold {
  if (value === 'fatal' || value === 'error' || value === 'info' || value === 'debug') {
    return value
  }
  return 'info'
}

export function setLogThreshold(level: unknown): LogThreshold {
  currentLogThreshold = normalizeLogThreshold(level)
  return currentLogThreshold
}

export function getLogThreshold(): LogThreshold {
  return currentLogThreshold
}

export function ensureLoggingDirs(): void {
  ensureDir(LOGS_DIR)
  ensureDir(EXPORTS_DIR)
  ensureDir(DIAGNOSTIC_DIR)
}

export function getCurrentRunId(): string {
  return currentRunId
}

function writeProjectedLog(file: LogFileKind, level: LogLevel, source: string, message: string, meta?: unknown): void {
  const metaText = serializeMeta(meta)
  if (file === 'app') {
    appendLine(APP_LOG_PATH, `[${new Date().toISOString()}] [${level.toUpperCase()}] [${source}] ${message}${metaText ? ` ${metaText}` : ''}`)
    return
  }
  appendLine(RENDERER_LOG_PATH, `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${metaText ? ` ${metaText}` : ''}`)
}

export function writeAppLog(level: LogLevel, source: string, message: string, meta?: unknown): void {
  writeProjectedLog('app', level, source, message, meta)
}

export function writeRendererLog(level: LogLevel, message: string, meta?: unknown): void {
  writeProjectedLog('renderer', level, 'renderer', message, meta)
}

export function writeUsageLog(entry: UsageLogEntry): void {
  const normalized = {
    category: entry.category,
    action: entry.action,
    status: entry.status,
    details: sanitizeDiagnosticDetails(entry.details || {}),
    sessionId: entry.sessionId || null,
    createdAt: entry.createdAt || Date.now(),
  }
  appendLine(USAGE_LOG_PATH, JSON.stringify(normalized))
}

export function readTextFile(path: string): string {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf-8')
}

export function writeExportFile(name: string, content: string): string {
  ensureLoggingDirs()
  const path = join(EXPORTS_DIR, name)
  writeFileSync(path, content, 'utf-8')
  return path
}

export function sanitizeForLogging<T>(value: T): T {
  return sanitizeDiagnosticDetails(value)
}

export function matchesLogThreshold(level: LogLevel, threshold: LogThreshold): boolean {
  return LOG_LEVEL_ORDER[level] <= LOG_THRESHOLD_ORDER[threshold]
}

function matchesExactLogLevel(level: LogLevel, exactLevel: GetLogsOptions['exactLevel'] | GetDiagnosticEventsOptions['exactLevel']): boolean {
  if (exactLevel == null || exactLevel === 'all') return true
  return level === normalizeLogLevel(exactLevel)
}

function splitBodyAndMeta(body: string): { message: string; metaText: string } {
  const trimmed = body.trimEnd()
  for (let index = trimmed.length - 1; index > 0; index -= 1) {
    if (trimmed[index] !== '{' || trimmed[index - 1] !== ' ') continue
    const candidate = trimmed.slice(index).trim()
    try {
      JSON.parse(candidate)
      return {
        message: trimmed.slice(0, index).trimEnd(),
        metaText: candidate,
      }
    } catch {
      continue
    }
  }
  return {
    message: trimmed,
    metaText: '',
  }
}

function parseLogMeta(metaText: string): Record<string, unknown> | null {
  if (!metaText) return null
  try {
    const parsed = JSON.parse(metaText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

function toKnownDiagnosticDomain(value: unknown): DiagnosticDomain | undefined {
  if (typeof value !== 'string') return undefined
  return DOMAIN_SET.has(value as DiagnosticDomain) ? value as DiagnosticDomain : undefined
}

function buildProjectedLogMeta(event: DiagnosticEvent): Record<string, unknown> {
  return {
    domain: event.domain,
    action: event.action,
    status: event.status,
    details: event.details,
  }
}

function parseLogFile(path: string, file: LogFileKind): Array<Omit<RuntimeLogEntry, 'cursor'>> {
  const content = readTextFile(path)
  if (!content.trim()) return []

  const pattern = file === 'app' ? APP_LOG_PATTERN : RENDERER_LOG_PATTERN
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(pattern)
      if (!match?.groups) return null
      const isoTime = match.groups.isoTime
      const timestamp = Date.parse(isoTime)
      if (Number.isNaN(timestamp)) return null
      const body = match.groups.body || ''
      const { message, metaText } = splitBodyAndMeta(body)
      const meta = parseLogMeta(metaText)
      return {
        timestamp,
        isoTime,
        level: normalizeLogLevel(match.groups.level || 'info'),
        source: file === 'app' ? (match.groups.source || 'app') : 'renderer',
        message,
        metaText,
        meta,
        domain: toKnownDiagnosticDomain(meta?.domain),
        action: typeof meta?.action === 'string' ? meta.action : undefined,
        file,
        raw: line,
      }
    })
    .filter((entry): entry is Omit<RuntimeLogEntry, 'cursor'> => Boolean(entry))
}

function parseCursor(cursor?: string): { timestamp: number; sequence: number } | null {
  if (!cursor) return null
  const [timestampText, sequenceText] = cursor.split(':')
  const timestamp = Number.parseInt(timestampText, 10)
  const sequence = Number.parseInt(sequenceText, 10)
  if (!Number.isFinite(timestamp) || !Number.isFinite(sequence)) {
    return null
  }
  return { timestamp, sequence }
}

function isAfterCursor(cursor: string, baseline: string | undefined): boolean {
  const entryCursor = parseCursor(cursor)
  const baselineCursor = parseCursor(baseline)
  if (!entryCursor || !baselineCursor) return true
  if (entryCursor.timestamp !== baselineCursor.timestamp) {
    return entryCursor.timestamp > baselineCursor.timestamp
  }
  return entryCursor.sequence > baselineCursor.sequence
}

function matchesQuery(value: string, query: string): boolean {
  if (!query) return true
  return value.toLowerCase().includes(query)
}

export function readStructuredLogs(options: GetLogsOptions = {}): GetLogsResult {
  const threshold = normalizeLogThreshold(options.level)
  const hasExactLevel = typeof options.exactLevel === 'string'
  const domain = options.domain && options.domain !== 'all' ? options.domain : null
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  const file = options.file === 'app' || options.file === 'renderer' ? options.file : 'all'
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000)

  const entries = [
    ...parseLogFile(APP_LOG_PATH, 'app'),
    ...parseLogFile(RENDERER_LOG_PATH, 'renderer'),
  ]
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
      if (left.file !== right.file) return left.file.localeCompare(right.file)
      return left.raw.localeCompare(right.raw)
    })
    .map((entry, index) => ({
      ...entry,
      cursor: `${entry.timestamp}:${index + 1}`,
    }))

  const matchingEntries = entries.filter((entry) => {
    if (file !== 'all' && entry.file !== file) return false
    if (domain && entry.domain !== domain) return false
    if (hasExactLevel) {
      if (!matchesExactLogLevel(entry.level, options.exactLevel)) return false
    } else if (!matchesLogThreshold(entry.level, threshold)) {
      return false
    }
    return matchesQuery([
      entry.isoTime,
      entry.level,
      entry.source,
      entry.domain || '',
      entry.action || '',
      entry.message,
      entry.metaText,
      entry.raw,
    ].join('\n'), query)
  })

  const latestCursor = matchingEntries.length > 0 ? matchingEntries[matchingEntries.length - 1].cursor : options.after || null
  const filtered = matchingEntries
    .filter((entry) => !options.after || isAfterCursor(entry.cursor, options.after))
    .slice(-limit)
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return right.timestamp - left.timestamp
      return right.cursor.localeCompare(left.cursor)
    })

  return {
    items: filtered,
    cursor: latestCursor,
    logDir: LOGS_DIR,
  }
}

function normalizeDomain(domain: string): DiagnosticDomain {
  if (!DOMAIN_SET.has(domain as DiagnosticDomain)) {
    return 'ui'
  }
  return domain as DiagnosticDomain
}

function buildDiagnosticEvent(options: DiagnosticRecordOptions): DiagnosticEvent {
  const ts = new Date().toISOString()
  return {
    ts,
    level: options.level,
    domain: normalizeDomain(options.domain),
    action: options.action,
    status: options.status,
    summary: options.summary,
    runId: currentRunId,
    source: options.source,
    requestId: options.requestId,
    sessionId: options.sessionId,
    errorCode: options.errorCode,
    durationMs: options.durationMs,
    details: sanitizeDiagnosticDetails(options.details || {}),
  }
}

export function recordDiagnosticEvent(options: DiagnosticRecordOptions): DiagnosticEvent {
  ensureLoggingDirs()
  const event = buildDiagnosticEvent(options)
  appendLine(getDiagnosticFilePath(new Date(event.ts)), JSON.stringify(event))
  if (options.projectTo) {
    writeProjectedLog(options.projectTo, event.level, event.source, event.summary, buildProjectedLogMeta(event))
  }
  return event
}

export function getAvailableLogDomains(): AvailableLogDomain[] {
  const counts = new Map<DiagnosticDomain, number>()

  const increment = (domain: DiagnosticDomain | undefined): void => {
    if (!domain) return
    counts.set(domain, (counts.get(domain) || 0) + 1)
  }

  for (const entry of parseLogFile(APP_LOG_PATH, 'app')) {
    increment(entry.domain)
  }

  for (const entry of parseLogFile(RENDERER_LOG_PATH, 'renderer')) {
    increment(entry.domain)
  }

  for (const event of readDiagnosticEventLines()) {
    increment(event.domain)
  }

  return DIAGNOSTIC_DOMAIN_ORDER
    .filter((domain) => (counts.get(domain) || 0) > 0)
    .map((domain) => ({
      value: domain,
      count: counts.get(domain) || 0,
    }))
}

export function recordMilestone(options: Omit<DiagnosticRecordOptions, 'level' | 'status'> & { status?: string }): DiagnosticEvent {
  return recordDiagnosticEvent({
    ...options,
    level: 'info',
    status: options.status || 'success',
    projectTo: options.projectTo || 'app',
  })
}

export function recordFailure(options: FailureRecordOptions): DiagnosticEvent {
  return recordDiagnosticEvent({
    level: options.fatal ? 'fatal' : 'error',
    domain: options.domain,
    action: options.action,
    status: 'failure',
    summary: options.summary,
    source: options.source,
    requestId: options.requestId,
    sessionId: options.sessionId,
    errorCode: options.errorCode,
    durationMs: options.durationMs,
    details: {
      reason: options.reason,
      impact: options.impact,
      suggestion: options.suggestion,
      ...options.details,
    },
    projectTo: options.projectTo || 'app',
  })
}

export function recordRetry(options: RetryRecordOptions): DiagnosticEvent {
  return recordDiagnosticEvent({
    level: 'warn',
    domain: options.domain,
    action: options.action,
    status: 'retrying',
    summary: options.summary,
    source: options.source,
    requestId: options.requestId,
    sessionId: options.sessionId,
    errorCode: options.errorCode,
    details: {
      reason: options.reason,
      retryInMs: options.retryInMs,
      impact: options.impact || '系统功能暂时不可用',
      suggestion: options.suggestion || '请稍后重试或检查本地服务状态',
      ...options.details,
    },
    projectTo: options.projectTo || 'app',
  })
}

function listDiagnosticFiles(): string[] {
  if (!existsSync(DIAGNOSTIC_DIR)) return []
  return readdirSync(DIAGNOSTIC_DIR)
    .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .map((name) => join(DIAGNOSTIC_DIR, name))
}

function truncateLogFile(path: string): void {
  ensureParent(path)
  writeFileSync(path, '', 'utf-8')
}

export function clearActiveLogs(): { cleared: string[] } {
  ensureLoggingDirs()

  const cleared: string[] = []
  const activeLogFiles = [APP_LOG_PATH, RENDERER_LOG_PATH, USAGE_LOG_PATH]

  for (const path of activeLogFiles) {
    truncateLogFile(path)
    cleared.push(path)
  }

  for (const path of listDiagnosticFiles()) {
    rmSync(path, { force: true })
    cleared.push(path)
  }

  ensureLoggingDirs()
  return { cleared }
}

function readDiagnosticEventLines(): DiagnosticEvent[] {
  const events: DiagnosticEvent[] = []
  for (const path of listDiagnosticFiles()) {
    const content = readTextFile(path)
    if (!content.trim()) continue
    for (const line of content.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as DiagnosticEvent
        if (!parsed.ts || !parsed.summary || !parsed.action || !parsed.domain) continue
        events.push({
          ...parsed,
          level: normalizeLogLevel(parsed.level),
          domain: normalizeDomain(parsed.domain),
          details: sanitizeDiagnosticDetails(parsed.details || {}),
        })
      } catch {
        continue
      }
    }
  }
  return events
}

export function readDiagnosticEvents(options: GetDiagnosticEventsOptions = {}): GetDiagnosticEventsResult {
  const threshold = normalizeLogThreshold(options.level)
  const hasExactLevel = typeof options.exactLevel === 'string'
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000)
  const domain = options.domain && options.domain !== 'all' ? normalizeDomain(options.domain) : null

  const entries = readDiagnosticEventLines()
    .map((event) => ({
      ...event,
      timestamp: Date.parse(event.ts),
    }))
    .filter((event) => Number.isFinite(event.timestamp))
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
      return left.summary.localeCompare(right.summary)
    })
    .map((event, index) => ({
      ...event,
      cursor: `${event.timestamp}:${index + 1}`,
    }))

  const matchingEntries = entries.filter((entry) => {
    if (hasExactLevel) {
      if (!matchesExactLogLevel(entry.level, options.exactLevel)) return false
    } else if (!matchesLogThreshold(entry.level, threshold)) {
      return false
    }
    if (domain && entry.domain !== domain) return false
    if (options.status && entry.status !== options.status) return false
    if (options.sessionId && entry.sessionId !== options.sessionId) return false
    if (options.requestId && entry.requestId !== options.requestId) return false
    const haystack = [
      entry.ts,
      entry.level,
      entry.domain,
      entry.action,
      entry.status,
      entry.summary,
      entry.errorCode || '',
      JSON.stringify(entry.details || {}),
    ].join('\n')
    return matchesQuery(haystack, query)
  })

  const latestCursor = matchingEntries.length > 0 ? matchingEntries[matchingEntries.length - 1].cursor : options.after || null
  const filtered = matchingEntries
    .filter((entry) => !options.after || isAfterCursor(entry.cursor, options.after))
    .slice(-limit)
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return right.timestamp - left.timestamp
      return right.cursor.localeCompare(left.cursor)
    })

  return {
    items: filtered,
    cursor: latestCursor,
    logDir: DIAGNOSTIC_DIR,
  }
}

function isHealthySummaryStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase()
  return normalized === 'success'
    || normalized === 'ok'
    || normalized === 'ready'
    || normalized === 'connected'
    || normalized === 'completed'
    || normalized === 'loaded'
    || normalized === 'available'
    || normalized === 'healthy'
}

function toSummaryItem(event: DiagnosticEventRecord): UserSummaryItem {
  const details = event.details || {}
  const isNormal = event.level === 'info' && isHealthySummaryStatus(event.status)
  const currentStatus = typeof details.currentStatus === 'string'
    ? details.currentStatus
    : isNormal
      ? '当前状态正常'
      : event.status === 'failure'
        ? '当前状态异常'
        : `当前状态：${event.status}`
  const impact = isNormal
    ? ''
    : typeof details.impact === 'string'
      ? details.impact
      : event.level === 'error' || event.level === 'fatal'
        ? '当前操作失败，相关功能可能不可用'
        : '当前流程尚未完成，相关功能可能暂时受限'
  const suggestion = isNormal
    ? ''
    : typeof details.suggestion === 'string'
      ? details.suggestion
      : event.level === 'error' || event.level === 'fatal'
        ? '请检查本地服务状态或查看诊断日志'
        : '请关注后续状态变化，必要时查看诊断日志'

  return {
    id: `${event.domain}:${event.action}:${event.cursor}`,
    level: event.level,
    domain: event.domain,
    title: event.summary,
    status: event.status,
    isNormal,
    currentStatus,
    impact,
    suggestion,
    timestamp: event.timestamp,
    isoTime: event.ts,
  }
}

export function getUserDiagnosticSummary(limit = 6): GetDiagnosticSummaryResult {
  const records = readDiagnosticEvents({ level: 'info', limit: 200 }).items
  const abnormal: UserSummaryItem[] = []
  const normal: UserSummaryItem[] = []
  const abnormalKeys = new Set<string>()
  const pickedKeys = new Set<string>()

  for (const event of records) {
    if (event.level === 'debug') continue
    const item = toSummaryItem(event)
    const key = `${event.domain}:${event.action}`
    if (item.isNormal || abnormalKeys.has(key)) continue
    abnormalKeys.add(key)
    pickedKeys.add(key)
    abnormal.push(item)
  }

  for (const event of records) {
    if (event.level === 'debug') continue
    const item = toSummaryItem(event)
    const key = `${event.domain}:${event.action}`
    if (!item.isNormal || pickedKeys.has(key)) continue
    pickedKeys.add(key)
    normal.push(item)
  }

  return { items: [...abnormal, ...normal].slice(0, limit) }
}
