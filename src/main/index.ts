import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { basename, extname, join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'fs'
import { spawn, ChildProcess } from 'child_process'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { harnessclawClient } from './harnessclaw'
import { manuallyCheckForUpdates, setupAutoUpdater } from './updater'
import {
  HARNESSCLAW_DIR,
  ENGINE_CONFIG_PATH,
  resolveBundledBinaryPath,
  ensureDir,
  readEngineConfig,
  saveEngineConfig,
  readHarnessclawConfig,
  saveHarnessclawConfig,
} from './config'
import {
  getDb, closeDb, upsertSession, updateSessionTitle, listSessions as dbListSessions,
  deleteSession as dbDeleteSession, insertMessage, updateMessageContent,
  getMessages, insertToolActivity, insertUsageEvent, listUsageEvents
} from './db'
import {
  APP_LOG_PATH,
  DIAGNOSTIC_DIR,
  LOGS_DIR,
  RENDERER_LOG_PATH,
  USAGE_LOG_PATH,
} from './runtime-paths'
import {
  type DiagnosticDomain,
  type GetDiagnosticEventsOptions,
  type LogLevel,
  type LogThreshold,
  type UsageLogEntry,
  ensureLoggingDirs,
  getAvailableLogDomains,
  getCurrentRunId,
  getUserDiagnosticSummary,
  getLogThreshold,
  normalizeLogThreshold,
  clearActiveLogs,
  readDiagnosticEvents,
  readStructuredLogs,
  recordFailure,
  recordMilestone,
  recordRetry,
  readTextFile,
  sanitizeForLogging,
  setLogThreshold,
  writeAppLog,
  writeExportFile,
  writeRendererLog,
  writeUsageLog,
} from './logging'

type PersistedSubagent = { taskId: string; label: string; status: string }

function normalizeSubagent(raw: unknown): PersistedSubagent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const candidate = raw as Record<string, unknown>
  const taskId = typeof candidate.task_id === 'string' ? candidate.task_id : ''
  const label = typeof candidate.label === 'string' ? candidate.label : ''
  const status = typeof candidate.status === 'string' ? candidate.status : ''
  if (!taskId || !label) return undefined
  return { taskId, label, status: status || 'ok' }
}

function isSameSubagent(
  left?: PersistedSubagent,
  right?: PersistedSubagent,
): boolean {
  return left?.taskId === right?.taskId
}

function getModuleKey(subagent?: PersistedSubagent): string {
  return subagent?.taskId || '__main__'
}

const HARNESSCLAW_LAUNCHED_FLAG = join(HARNESSCLAW_DIR, '.launched')
const HARNESSCLAW_ENGINE_BIN = resolveBundledBinaryPath('harnessclaw-engine')
const SKILLS_DIR = join(HARNESSCLAW_DIR, 'workspace', 'skills')

let harnessclawEngineProcess: ChildProcess | null = null

interface PickedLocalFile {
  name: string
  path: string
  url: string
  size: number
  extension: string
  kind: 'image' | 'video' | 'audio' | 'archive' | 'code' | 'document' | 'data' | 'other'
}

interface AppRuntimeStatus {
  localService: 'starting' | 'ready' | 'degraded'
  transport: 'disconnected' | 'connecting' | 'connected'
  llmConfigured: boolean
  applyingConfig: boolean
  lastError?: string
}

function logInfo(domain: DiagnosticDomain, action: string, summary: string, details?: Record<string, unknown>, projectTo: 'app' | 'renderer' = 'app'): void {
  recordMilestone({
    domain,
    action,
    summary,
    source: 'main',
    details,
    projectTo,
  })
}

function logFailure(
  domain: DiagnosticDomain,
  action: string,
  summary: string,
  reason: string,
  impact: string,
  suggestion: string,
  details?: Record<string, unknown>,
  fatal = false,
): void {
  recordFailure({
    domain,
    action,
    summary,
    source: 'main',
    reason,
    impact,
    suggestion,
    details,
    fatal,
    projectTo: 'app',
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function inferConfiguredProvider(config: Record<string, unknown>): string {
  const providers = asRecord(config.providers)
  for (const [key, rawValue] of Object.entries(providers)) {
    const provider = asRecord(rawValue)
    if (provider.enabled === false) continue
    if (typeof provider.api_key === 'string' && provider.api_key.trim()) {
      return key
    }
  }
  return 'unknown'
}

function inferAppRuntimeStatus(): AppRuntimeStatus {
  const harnessStatus = harnessclawClient.getStatus()
  const config = readEngineConfig({ providers: {} })
  return {
    localService: harnessStatus.status === 'disconnected' ? 'degraded' : 'ready',
    transport: harnessStatus.status as AppRuntimeStatus['transport'],
    llmConfigured: inferConfiguredProvider(config) !== 'unknown',
    applyingConfig: false,
    lastError: harnessStatus.status === 'disconnected' ? 'Harnessclaw websocket disconnected' : undefined,
  }
}

function broadcastAppRuntimeStatus(): void {
  const status = inferAppRuntimeStatus()
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('app-runtime:status', status)
  })
}

function classifyFileKind(extension: string): PickedLocalFile['kind'] {
  const ext = extension.toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(ext)) return 'audio'
  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return 'archive'
  if (['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.cs', '.json', '.yml', '.yaml', '.toml', '.xml', '.md', '.sql', '.sh', '.ps1', '.bat'].includes(ext)) return 'code'
  if (['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.rtf'].includes(ext)) return 'document'
  if (['.csv', '.parquet', '.log'].includes(ext)) return 'data'
  return 'other'
}

function buildPickedLocalFiles(filePaths: string[]): PickedLocalFile[] {
  const uniquePaths = [...new Set(filePaths.map((value) => value.trim()).filter(Boolean))]
  const files: PickedLocalFile[] = []

  for (const filePath of uniquePaths) {
    try {
      const stats = statSync(filePath)
      if (!stats.isFile()) continue

      const extension = extname(filePath)
      files.push({
        name: basename(filePath),
        path: filePath,
        url: pathToFileURL(filePath).toString(),
        size: stats.size,
        extension,
        kind: classifyFileKind(extension),
      })
    } catch (error) {
      console.warn('[Files] Failed to read file metadata:', filePath, error)
    }
  }

  return files
}

function trackUsage(entry: UsageLogEntry): void {
  const createdAt = entry.createdAt || Date.now()
  const details = sanitizeForLogging(entry.details || {})
  try {
    insertUsageEvent({
      category: entry.category,
      action: entry.action,
      status: entry.status,
      detailsJson: JSON.stringify(details),
      sessionId: entry.sessionId,
      createdAt,
    })
  } catch (error) {
    writeAppLog('error', 'usage', 'Failed to insert usage event', { entry, error: String(error) })
    logFailure(
      'ui',
      'usage.persist',
      '使用记录保存失败',
      error instanceof Error ? error.message : String(error),
      '使用统计可能缺失，但不影响主功能运行',
      '可稍后查看日志或重试当前操作',
      { entry, error },
    )
  }
  writeUsageLog({ ...entry, details, createdAt })
}

function buildExportPayload(type: string): { name: string; content: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (type === 'logs') {
    return {
      name: `logs-export-${stamp}.json`,
      content: JSON.stringify({
        exportedAt: new Date().toISOString(),
        runId: getCurrentRunId(),
        appLog: readTextFile(APP_LOG_PATH),
        rendererLog: readTextFile(RENDERER_LOG_PATH),
        usageLog: readTextFile(USAGE_LOG_PATH),
        diagnosticDir: DIAGNOSTIC_DIR,
        diagnosticEvents: readDiagnosticEvents({ level: 'debug', limit: 2000 }).items,
        usageEvents: listUsageEvents(1000),
      }, null, 2),
    }
  }

  if (type === 'config') {
    return {
      name: `config-export-${stamp}.json`,
      content: JSON.stringify({
        exportedAt: new Date().toISOString(),
        engineConfig: sanitizeForLogging(readEngineConfig({ providers: {} })),
        appConfig: sanitizeForLogging(readHarnessclawConfig({})),
      }, null, 2),
    }
  }

  return {
    name: `chat-export-${stamp}.json`,
    content: JSON.stringify({
      exportedAt: new Date().toISOString(),
      sessions: dbListSessions().map((session) => ({
        ...session,
        messages: getMessages(session.session_id),
      })),
    }, null, 2),
  }
}

function startHarnessclawEngine(): void {
  if (harnessclawEngineProcess) return
  if (!HARNESSCLAW_ENGINE_BIN || !existsSync(HARNESSCLAW_ENGINE_BIN)) {
    console.warn('[HarnessclawEngine] Binary not found:', HARNESSCLAW_ENGINE_BIN || '<missing>')
    logFailure(
      'runtime.harnessclaw',
      'start',
      '本地运行时启动失败：未找到可执行文件',
      'bundled binary 缺失',
      '本地运行时不可用，聊天与连接功能无法工作',
      '请确认 resources/bin 下存在 harnessclaw-engine 可执行文件',
      { binaryPath: HARNESSCLAW_ENGINE_BIN || '<missing>' },
    )
    return
  }
  logInfo('runtime.harnessclaw', 'start.requested', '已请求启动本地运行时', {
    binaryPath: HARNESSCLAW_ENGINE_BIN,
    configPath: ENGINE_CONFIG_PATH,
  })
  harnessclawEngineProcess = spawn(HARNESSCLAW_ENGINE_BIN, ['-config', ENGINE_CONFIG_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  harnessclawEngineProcess.stdout?.on('data', (data) => {
    process.stdout.write(`[HarnessclawEngine] ${data}`)
  })
  harnessclawEngineProcess.stderr?.on('data', (data) => {
    process.stderr.write(`[HarnessclawEngine] ${data}`)
  })
  harnessclawEngineProcess.on('error', (err) => {
    logFailure(
      'runtime.harnessclaw',
      'start',
      '本地运行时启动失败：进程创建未成功',
      err instanceof Error ? err.message : String(err),
      '本地运行时不可用，聊天与连接功能无法工作',
      '请检查本地运行时文件和配置是否有效',
      { error: err },
    )
    harnessclawEngineProcess = null
  })
  harnessclawEngineProcess.on('exit', (code) => {
    if (code === 0 || code === null) {
      logInfo('runtime.harnessclaw', 'stop', '本地运行时已停止', { exitCode: code })
    } else {
      logFailure(
        'runtime.harnessclaw',
        'exit',
        '本地运行时异常退出',
        `退出码 ${code}`,
        '本地服务连接会中断，相关功能暂时不可用',
        '请检查本地运行时日志并尝试重新启动应用',
        { exitCode: code },
      )
    }
    harnessclawEngineProcess = null
  })
}

function stopHarnessclawEngine(): void {
  if (!harnessclawEngineProcess) return
  logInfo('runtime.harnessclaw', 'stop.requested', '已请求停止本地运行时')
  harnessclawEngineProcess.kill('SIGTERM')
  harnessclawEngineProcess = null
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#F5F5F7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setupAutoUpdater(mainWindow)
  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.iflytek.harnessclaw')
  ensureLoggingDirs()
  setLogThreshold(normalizeLogThreshold(asRecord(readHarnessclawConfig({})).logging?.level))
  logInfo('app.lifecycle', 'startup', '应用启动成功', {
    currentStatus: '本地应用已完成初始化',
    impact: '主界面与本地服务连接流程已开始工作',
    suggestion: '当前无需处理',
    runId: getCurrentRunId(),
  })

  process.on('uncaughtException', (error) => {
    logFailure(
      'app.lifecycle',
      'uncaughtException',
      '应用发生未捕获异常',
      error.message,
      '当前操作可能失败，部分功能可能不可用',
      '请查看诊断日志并尝试重新启动应用',
      { error },
      true,
    )
  })

  process.on('unhandledRejection', (reason) => {
    logFailure(
      'app.lifecycle',
      'unhandledRejection',
      '应用发生未处理的异步异常',
      reason instanceof Error ? reason.message : String(reason),
      '当前操作可能失败，部分功能可能不可用',
      '请查看诊断日志并尝试重新执行操作',
      { reason },
    )
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    logInfo('app.lifecycle', 'window.created', '主窗口已创建', {
      currentStatus: '桌面窗口已创建',
      impact: '界面交互已就绪',
      suggestion: '当前无需处理',
    })
  })

  // First-launch detection
  ipcMain.handle('app:isFirstLaunch', () => {
    return !existsSync(HARNESSCLAW_LAUNCHED_FLAG)
  })

  ipcMain.handle('app:markLaunched', () => {
    try {
      if (!existsSync(HARNESSCLAW_DIR)) {
        mkdirSync(HARNESSCLAW_DIR, { recursive: true })
      }
      writeFileSync(HARNESSCLAW_LAUNCHED_FLAG, new Date().toISOString(), 'utf-8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // Config file read/write
  ipcMain.handle('config:read', () => {
    const config = readEngineConfig({ providers: {} })
    logInfo('config', 'read', '已读取运行时配置', {
      currentStatus: '当前配置已载入',
      impact: '设置页显示的是最近一次保存的配置',
      suggestion: '如需修改，可在设置页保存并应用',
    })
    return config
  })

  ipcMain.handle('config:save', (_, data: unknown) => {
    ensureDir(HARNESSCLAW_DIR)
    const result = saveEngineConfig(data)
    if (result.ok) {
      logInfo('config', 'save', '配置已保存：运行时配置已更新', {
        currentStatus: '配置文件已写入本地磁盘',
        impact: '下次应用或重启运行时会使用新配置',
        suggestion: '如需立即生效，请执行应用配置或重启运行时',
      })
    } else {
      logFailure(
        'config',
        'save',
        '配置保存失败：运行时配置未写入',
        result.error || '未知错误',
        '新配置不会生效，系统继续使用旧配置',
        '请检查配置内容和本地目录写入权限',
        { config: data },
      )
    }
    return result
  })

  ipcMain.handle('app-config:read', () => {
    return readHarnessclawConfig({})
  })

  ipcMain.handle('app-config:save', (_, data: unknown) => {
    ensureDir(HARNESSCLAW_DIR)
    const result = saveHarnessclawConfig(data)
    if (result.ok) {
      setLogThreshold(normalizeLogThreshold(asRecord(asRecord(data).logging).level))
      broadcastAppRuntimeStatus()
      logInfo('config', 'apply', '配置已应用：本地运行时设置已更新', {
        currentStatus: '最新配置已应用到本地应用',
        impact: '日志级别和界面相关设置已生效',
        suggestion: '如涉及运行时连接参数，可检查本地服务是否按预期重连',
      })
    } else {
      logFailure(
        'config',
        'apply',
        '配置应用失败：设置未生效',
        result.error || '未知错误',
        '应用继续使用旧设置',
        '请检查配置内容并重试保存',
        { config: data },
      )
    }
    return result
  })

  ipcMain.handle('app-runtime:getStatus', () => {
    return inferAppRuntimeStatus()
  })

  ipcMain.handle('app-runtime:getLogLevel', () => {
    return getLogThreshold()
  })

  ipcMain.handle('app-runtime:getLogs', (_, options) => {
    return readStructuredLogs(options || {})
  })

  ipcMain.handle('app-runtime:getDiagnosticEvents', (_, options?: GetDiagnosticEventsOptions) => {
    return readDiagnosticEvents(options || {})
  })

  ipcMain.handle('app-runtime:getDiagnosticSummary', () => {
    return getUserDiagnosticSummary()
  })

  ipcMain.handle('app-runtime:getAvailableLogDomains', () => {
    return getAvailableLogDomains()
  })

  ipcMain.handle('app-runtime:openLogsDirectory', async () => {
    const error = await shell.openPath(LOGS_DIR)
    return {
      ok: !error,
      path: LOGS_DIR,
      error: error || undefined,
    }
  })

  ipcMain.handle('app-runtime:clearLogs', () => {
    try {
      const result = clearActiveLogs()
      return { ok: true, cleared: result.cleared }
    } catch (error) {
      return { ok: false, cleared: [], error: String(error) }
    }
  })
  ipcMain.handle('app-runtime:logRenderer', (_, level: LogLevel, message: string, details?: Record<string, unknown>) => {
    writeRendererLog(level, message, details)
    return { ok: true }
  })

  ipcMain.handle('app-runtime:trackUsage', (_, entry: UsageLogEntry) => {
    trackUsage(entry)
    return { ok: true }
  })

  ipcMain.handle('app-runtime:exportData', (_, type: string) => {
    try {
      const payload = buildExportPayload(type)
      const path = writeExportFile(payload.name, payload.content)
      return { ok: true, path }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })

  // Skills reader
  ipcMain.handle('skills:list', () => {
    try {
      if (!existsSync(SKILLS_DIR)) return []
      const dirs = readdirSync(SKILLS_DIR).filter((name) => {
        const full = join(SKILLS_DIR, name)
        return statSync(full).isDirectory() && existsSync(join(full, 'SKILL.md'))
      })
      return dirs.map((dirName) => {
        const md = readFileSync(join(SKILLS_DIR, dirName, 'SKILL.md'), 'utf-8')
        // Parse YAML frontmatter
        const match = md.match(/^---\n([\s\S]*?)\n---/)
        const meta: Record<string, string> = {}
        if (match) {
          match[1].split('\n').forEach((line) => {
            const idx = line.indexOf(':')
            if (idx > 0) {
              meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
            }
          })
        }
        // Check for references and templates dirs
        const hasRefs = existsSync(join(SKILLS_DIR, dirName, 'references'))
        const hasTemplates = existsSync(join(SKILLS_DIR, dirName, 'templates'))
        return {
          id: dirName,
          name: meta.name || dirName,
          description: meta.description || '',
          allowedTools: meta['allowed-tools'] || '',
          hasReferences: hasRefs,
          hasTemplates: hasTemplates,
        }
      })
    } catch (err) {
      console.error('[Skills] Failed to list:', err)
      return []
    }
  })

  ipcMain.handle('skills:read', (_, id: string) => {
    try {
      const filePath = join(SKILLS_DIR, id, 'SKILL.md')
      if (!existsSync(filePath)) return ''
      return readFileSync(filePath, 'utf-8')
    } catch (err) {
      console.error('[Skills] Failed to read:', err)
      return ''
    }
  })

  ipcMain.handle('skills:delete', (_, id: string) => {
    try {
      const trimmed = id.trim()
      if (!trimmed || trimmed.includes('..') || trimmed.includes('/')) {
        return { ok: false, error: 'Invalid skill id' }
      }
      const skillDir = join(SKILLS_DIR, trimmed)
      if (!existsSync(skillDir)) {
        return { ok: false, error: 'Skill not found' }
      }
      rmSync(skillDir, { recursive: true, force: true })
      console.log('[Skills] Deleted:', trimmed)
      return { ok: true }
    } catch (err) {
      console.error('[Skills] Failed to delete:', err)
      return { ok: false, error: String(err) }
    }
  })

  // Start bundled harnessclaw engine, then connect Harnessclaw (auto-retries until engine is ready)
  startHarnessclawEngine()
  try {
    getDb()
    logInfo('storage.db', 'init', '本地数据库初始化成功', {
      currentStatus: '会话与日志数据库已可用',
      impact: '历史会话和统计数据可正常读写',
      suggestion: '当前无需处理',
    })
  } catch (error) {
    logFailure(
      'storage.db',
      'init',
      '本地数据库初始化失败',
      error instanceof Error ? error.message : String(error),
      '会话历史与统计数据可能无法保存',
      '请检查本地磁盘权限与数据库文件状态',
      { error },
      true,
    )
    throw error
  }
  harnessclawClient.connect()

  harnessclawClient.on('statusChange', (status) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('harnessclaw:status', status)
    })
    broadcastAppRuntimeStatus()
  })

  // DB IPC handlers
  ipcMain.handle('db:listSessions', () => {
    try {
      return dbListSessions()
    } catch (err) {
      console.error('[DB] listSessions error:', err)
      return []
    }
  })

  ipcMain.handle('db:getMessages', (_, sessionId: string) => {
    try {
      return getMessages(sessionId)
    } catch (err) {
      console.error('[DB] getMessages error:', err)
      return []
    }
  })

  ipcMain.handle('db:deleteSession', (_, sessionId: string) => {
    try {
      dbDeleteSession(sessionId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('files:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return []
    }

    return buildPickedLocalFiles(result.filePaths)
  })

  ipcMain.handle('files:resolve', (_, filePaths: string[]) => {
    return buildPickedLocalFiles(Array.isArray(filePaths) ? filePaths : [])
  })

  // Track pending assistant message IDs per session for DB writes
  const pendingDbAssistantIds: Record<string, string> = {}
  const pendingDbSegments: Record<string, {
    segments: Array<{ text: string; ts: number; subagent?: PersistedSubagent }>
    lastToolTsByModule: Record<string, number>
  }> = {}

  harnessclawClient.on('event', (event) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('harnessclaw:event', event)
    })

    // Write to DB based on event type
    const type = event.type as string
    const sid = event.session_id as string | undefined
    const subagent = normalizeSubagent(event.subagent)
    try {
      const ensureDbAssistantMessage = (sessionId: string, now: number): string => {
        let aid = pendingDbAssistantIds[sessionId]
        if (aid) return aid

        aid = `ast-${now}`
        pendingDbAssistantIds[sessionId] = aid
        pendingDbSegments[sessionId] = { segments: [], lastToolTsByModule: {} }
        insertMessage({ id: aid, sessionId, role: 'assistant', content: '', contentSegments: [], createdAt: now })
        return aid
      }

      switch (type) {
        case 'connected': {
          // Don't auto-create session in DB — session is created when user sends first message
          break
        }
        case 'turn_start': {
          if (sid) {
            const now = Date.now()
            if (subagent) {
              const aid = ensureDbAssistantMessage(sid, now)
              insertToolActivity(aid, {
                type: 'status',
                name: 'turn_start',
                content: subagent.status === 'running' ? '子任务启动' : '开始总结',
                subagent,
              })
              break
            }
            const id = `ast-${now}`
            pendingDbAssistantIds[sid] = id
            pendingDbSegments[sid] = { segments: [], lastToolTsByModule: {} }
            insertMessage({ id, sessionId: sid, role: 'assistant', content: '', contentSegments: [], createdAt: now })
          }
          break
        }
        case 'task_start': {
          if (sid && subagent) {
            const aid = ensureDbAssistantMessage(sid, Date.now())
            insertToolActivity(aid, {
              type: 'status',
              name: 'task_start',
              content: '子任务已创建',
              subagent,
            })
          }
          break
        }
        case 'tool_hint': {
          if (sid) {
            const aid = ensureDbAssistantMessage(sid, Date.now())
            if (aid) {
              insertToolActivity(aid, { type: 'hint', content: (event.content as string) || '', subagent })
              const state = pendingDbSegments[sid]
              if (state) state.lastToolTsByModule[getModuleKey(subagent)] = Date.now()
            }
          }
          break
        }
        case 'tool_call': {
          if (sid) {
            const aid = ensureDbAssistantMessage(sid, Date.now())
            if (aid) {
              insertToolActivity(aid, {
                type: 'call',
                name: event.name as string,
                content: JSON.stringify(event.arguments, null, 2),
                callId: event.call_id as string,
                subagent,
              })
              const state = pendingDbSegments[sid]
              if (state) state.lastToolTsByModule[getModuleKey(subagent)] = Date.now()
            }
          }
          break
        }
        case 'tool_result': {
          if (sid) {
            const aid = ensureDbAssistantMessage(sid, Date.now())
            if (aid) {
              insertToolActivity(aid, {
                type: 'result',
                name: event.name as string,
                content: (event.content as string) || '',
                callId: event.call_id as string,
                isError: event.is_error as boolean,
                subagent,
              })
              const state = pendingDbSegments[sid]
              if (state) state.lastToolTsByModule[getModuleKey(subagent)] = Date.now()
            }
          }
          break
        }
        case 'permission_request': {
          if (sid) {
            const aid = ensureDbAssistantMessage(sid, Date.now())
            if (aid) {
              insertToolActivity(aid, {
                type: 'permission',
                name: event.name as string,
                content: JSON.stringify({
                  tool_input: (event.tool_input as string) || '',
                  message: (event.content as string) || '',
                  is_read_only: event.is_read_only === true,
                  options: Array.isArray(event.options) ? event.options : [],
                }),
                callId: event.request_id as string,
                subagent,
              })
              const state = pendingDbSegments[sid]
              if (state) state.lastToolTsByModule[getModuleKey(subagent)] = Date.now()
            }
          }
          break
        }
        case 'permission_result': {
          if (sid) {
            const aid = ensureDbAssistantMessage(sid, Date.now())
            if (aid) {
              insertToolActivity(aid, {
                type: 'permission_result',
                name: event.name as string,
                content: JSON.stringify({
                  approved: event.approved === true,
                  scope: event.scope === 'session' ? 'session' : 'once',
                  message: (event.content as string) || '',
                }),
                callId: event.request_id as string,
                isError: event.approved !== true,
                subagent,
              })
              const state = pendingDbSegments[sid]
              if (state) state.lastToolTsByModule[getModuleKey(subagent)] = Date.now()
            }
          }
          break
        }
        case 'text_delta': {
          if (sid) {
            let aid = pendingDbAssistantIds[sid]
            const chunk = event.content as string
            const now = Date.now()
            if (!aid) {
              aid = ensureDbAssistantMessage(sid, now)
              const initialSegments = chunk ? [{ text: chunk, ts: now, subagent }] : []
              pendingDbSegments[sid] = { ...(pendingDbSegments[sid] || { lastToolTsByModule: {}, segments: [] }), segments: initialSegments }
              updateMessageContent(aid, chunk || '', initialSegments)
            } else if (chunk) {
              const state = pendingDbSegments[sid] || { segments: [], lastToolTsByModule: {} }
              const segments = [...state.segments]
              const moduleKey = getModuleKey(subagent)
              const lastSegIndex = [...segments].reverse().findIndex((seg) => getModuleKey(seg.subagent) === moduleKey)
              const resolvedLastSegIndex = lastSegIndex === -1 ? -1 : segments.length - 1 - lastSegIndex
              const lastSeg = resolvedLastSegIndex >= 0 ? segments[resolvedLastSegIndex] : undefined
              const lastRelatedToolTs = state.lastToolTsByModule[moduleKey] || 0
              if (lastSeg && lastRelatedToolTs <= lastSeg.ts && isSameSubagent(lastSeg.subagent, subagent)) {
                segments[resolvedLastSegIndex] = { ...lastSeg, text: lastSeg.text + chunk, ts: lastSeg.ts }
              } else {
                segments.push({ text: chunk, ts: now, subagent })
              }
              pendingDbSegments[sid] = { ...state, segments }
              updateMessageContent(aid, chunk, segments)
            }
          }
          break
        }
        case 'response': {
          if (sid) {
            let aid = pendingDbAssistantIds[sid]
            const content = (event.content as string) || ''
            const now = Date.now()
            const toolsUsed = event.tools_used as string[] | undefined
            const usage = event.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined

            if (!aid) {
              aid = ensureDbAssistantMessage(sid, now)
              const segments = content ? [{ text: content, ts: now, subagent }] : []
              pendingDbSegments[sid] = { segments, lastToolTsByModule: {} }
              updateMessageContent(aid, content, segments)
            } else {
              const segments = pendingDbSegments[sid]?.segments || []
              if (content && segments.length === 0) {
                pendingDbSegments[sid] = { segments: [{ text: content, ts: now, subagent }], lastToolTsByModule: {} }
              }
              updateMessageContent(aid, content, pendingDbSegments[sid]?.segments)
            }

            if (!subagent) {
              updateMessageContent(aid, '', pendingDbSegments[sid]?.segments, toolsUsed, usage)
              delete pendingDbAssistantIds[sid]
              delete pendingDbSegments[sid]
            }
          }
          break
        }
        case 'response_end': {
          if (sid) {
            const aid = pendingDbAssistantIds[sid]
            if (aid) {
              if (subagent) {
                insertToolActivity(aid, {
                  type: 'status',
                  name: 'response_end',
                  content: subagent.status === 'error' ? '子任务失败' : '子任务完成',
                  subagent,
                })
                break
              }
              const toolsUsed = event.tools_used as string[] | undefined
              const usage = event.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined
              // Content already accumulated via text_delta; just update metadata
              updateMessageContent(aid, '', pendingDbSegments[sid]?.segments, toolsUsed, usage)
              delete pendingDbAssistantIds[sid]
              delete pendingDbSegments[sid]
            }
          }
          break
        }
        case 'task_end': {
          if (sid) {
            const aid = pendingDbAssistantIds[sid]
            if (aid && subagent) {
              insertToolActivity(aid, {
                type: 'status',
                name: 'task_end',
                content: subagent.status === 'error' ? '子任务生命周期结束，状态失败' : '子任务生命周期结束',
                subagent,
              })
            }
          }
          break
        }
      }
    } catch (err) {
      console.error('[DB] Event write error:', type, err)
    }
  })

  ipcMain.handle('harnessclaw:connect', () => {
    harnessclawClient.connect()
    return { ok: true }
  })

  ipcMain.handle('harnessclaw:disconnect', () => {
    harnessclawClient.disconnect()
    return { ok: true }
  })

  ipcMain.handle('harnessclaw:send', async (_, content: string, sessionId?: string) => {
    const ok = await harnessclawClient.send(content, sessionId)
    if (!ok) {
      return { ok: false, error: 'Failed to send message to Harnessclaw' }
    }
    // Write user message to DB
    if (sessionId) {
      try {
        upsertSession(sessionId)
        const msgId = `usr-${Date.now()}`
        insertMessage({ id: msgId, sessionId, role: 'user', content, createdAt: Date.now() })
        // Use first user message as session title
        const msgs = getMessages(sessionId)
        const userMsgs = msgs.filter((m) => m.role === 'user')
        if (userMsgs.length === 1) {
          const title = content.trim().replace(/\n/g, ' ')
          const truncated = title.length > 50 ? title.slice(0, 50) + '...' : title
          updateSessionTitle(sessionId, truncated)
        }
      } catch (err) {
        console.error('[DB] Send write error:', err)
      }
    }
    return { ok: true }
  })

  ipcMain.handle('harnessclaw:command', (_, cmd: string, sessionId?: string) => {
    harnessclawClient.command(cmd, sessionId)
    return { ok: true }
  })

  ipcMain.handle('harnessclaw:stop', async (_, sessionId?: string) => {
    const ok = await harnessclawClient.stop(sessionId)
    return ok ? { ok: true } : { ok: false, error: 'Failed to interrupt Harnessclaw session' }
  })

  ipcMain.handle('harnessclaw:subscribe', (_, sessionId: string) => {
    harnessclawClient.subscribe(sessionId)
    return { ok: true }
  })

  ipcMain.handle('harnessclaw:unsubscribe', (_, sessionId: string) => {
    harnessclawClient.unsubscribe(sessionId)
    return { ok: true }
  })

  ipcMain.handle('harnessclaw:listSessions', () => {
    harnessclawClient.listSessions()
    return { ok: true }
  })

  ipcMain.handle('harnessclaw:probe', async () => {
    const ok = await harnessclawClient.probe()
    return { ok }
  })

  ipcMain.handle('harnessclaw:respondPermission', (_, requestId: string, approved: boolean, scope?: 'once' | 'session', message?: string) => {
    const ok = harnessclawClient.respondPermission(requestId, approved, scope === 'session' ? 'session' : 'once', message)
    return ok ? { ok: true } : { ok: false, error: 'Permission request not found or socket unavailable' }
  })

  ipcMain.handle('harnessclaw:status', () => {
    return harnessclawClient.getStatus()
  })

  ipcMain.handle('app:update:check', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      return { ok: false, error: 'No active window' }
    }
    return manuallyCheckForUpdates(win)
  })

  createWindow()
  broadcastAppRuntimeStatus()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  logInfo('app.lifecycle', 'quit', '应用正在退出', {
    currentStatus: '应用退出流程进行中',
    impact: '本地连接与窗口将关闭',
    suggestion: '当前无需处理',
  })
  harnessclawClient.disconnect()
  stopHarnessclawEngine()
  closeDb()
})
