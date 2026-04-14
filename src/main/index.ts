import { app, shell, BrowserWindow, ipcMain, dialog, nativeImage } from 'electron'
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
  clearActiveLogs,
  ensureLoggingDirs,
  getAvailableLogDomains,
  getCurrentRunId,
  getUserDiagnosticSummary,
  getLogThreshold,
  normalizeLogThreshold,
  readDiagnosticEvents,
  readStructuredLogs,
  recordFailure,
  recordMilestone,
  readTextFile,
  sanitizeForLogging,
  setLogThreshold,
  writeAppLog,
  writeExportFile,
  writeRendererLog,
  writeUsageLog,
} from './logging'
import {
  deleteInstalledSkill,
  discoverSkills,
  installDiscoveredSkill,
  listDiscoveredSkills,
  listInstalledSkills,
  listSkillRepositories,
  previewDiscoveredSkill,
  readInstalledSkill,
  removeSkillRepository,
  saveSkillRepository,
} from './skills-market'

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
let harnessclawEngineProcess: ChildProcess | null = null

function resolveDevIconPath(): string | undefined {
  const candidates = [
    join(process.cwd(), 'resources', 'icon.png'),
    join(app.getAppPath(), 'resources', 'icon.png'),
  ]

  return candidates.find((candidate) => existsSync(candidate))
}

function applyDevAppIcon(): string | undefined {
  const iconPath = resolveDevIconPath()
  if (!iconPath) return undefined

  if (process.platform === 'darwin') {
    const image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) {
      app.dock.setIcon(image)
    }
  }

  return iconPath
}

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

function logInfo(
  domain: DiagnosticDomain,
  action: string,
  summary: string,
  details?: Record<string, unknown>,
  projectTo: 'app' | 'renderer' = 'app',
): void {
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
      'Failed to persist usage event',
      error instanceof Error ? error.message : String(error),
      'Usage analytics may be incomplete, but core features can continue running.',
      'You can inspect the logs and retry the action if needed.',
      { entry, error: String(error) },
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
      'Local runtime failed to start because the bundled binary was not found',
      'Bundled harnessclaw-engine binary is missing.',
      'Local runtime features cannot initialize, so chat and connectivity may be unavailable.',
      'Verify that resources/bin contains the expected harnessclaw-engine executable.',
      { binaryPath: HARNESSCLAW_ENGINE_BIN || '<missing>' },
    )
    return
  }

  logInfo('runtime.harnessclaw', 'start.requested', 'Requested local runtime startup', {
    binaryPath: HARNESSCLAW_ENGINE_BIN,
    configPath: ENGINE_CONFIG_PATH,
    currentStatus: 'Startup request has been issued.',
    impact: 'The local engine process should come online shortly.',
    suggestion: 'No action is needed unless startup fails.',
  })

  console.log('[HarnessclawEngine] Starting engine...')
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
    console.error('[HarnessclawEngine] Failed to start:', err)
    logFailure(
      'runtime.harnessclaw',
      'start',
      'Local runtime failed to spawn',
      err instanceof Error ? err.message : String(err),
      'Local runtime features remain unavailable until the engine can start.',
      'Check the runtime binary and engine config, then retry startup.',
      { error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) },
    )
    harnessclawEngineProcess = null
  })
  harnessclawEngineProcess.on('exit', (code) => {
    console.log('[HarnessclawEngine] Exited with code:', code)
    if (code === 0 || code === null) {
      logInfo('runtime.harnessclaw', 'stop', 'Local runtime stopped', {
        exitCode: code,
        currentStatus: 'The engine process is no longer running.',
        impact: 'New requests will wait until the runtime is started again.',
        suggestion: 'If this was not expected, inspect the runtime logs.',
      })
    } else {
      logFailure(
        'runtime.harnessclaw',
        'exit',
        'Local runtime exited unexpectedly',
        `Process exited with code ${code}.`,
        'The websocket connection and runtime-backed features may stop working.',
        'Review the runtime logs and restart the application or engine.',
        { exitCode: code },
      )
    }
    harnessclawEngineProcess = null
  })
}

function stopHarnessclawEngine(): void {
  if (!harnessclawEngineProcess) return
  console.log('[HarnessclawEngine] Stopping engine...')
  logInfo('runtime.harnessclaw', 'stop.requested', 'Requested local runtime shutdown', {
    currentStatus: 'Shutdown signal has been sent to the engine process.',
    impact: 'Local runtime activity will stop during app shutdown or manual disconnect.',
    suggestion: 'No action is needed unless the process does not exit cleanly.',
  })
  harnessclawEngineProcess.kill('SIGTERM')
  harnessclawEngineProcess = null
}

function createWindow(): BrowserWindow {
  const devIconPath = is.dev ? applyDevAppIcon() : undefined
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
    ...(process.platform === 'darwin' ? {} : devIconPath ? { icon: devIconPath } : {}),
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
  logInfo('app.lifecycle', 'startup', 'Application startup completed', {
    runId: getCurrentRunId(),
    currentStatus: 'Main process initialization has completed.',
    impact: 'Window creation and local service startup can proceed.',
    suggestion: 'No action is needed.',
  })

  process.on('uncaughtException', (error) => {
    logFailure(
      'app.lifecycle',
      'uncaughtException',
      'Unhandled exception in the main process',
      error.message,
      'The current operation may fail and part of the app could become unstable.',
      'Inspect the diagnostic logs and restart the app if instability continues.',
      { error: { name: error.name, message: error.message, stack: error.stack } },
      true,
    )
  })

  process.on('unhandledRejection', (reason) => {
    logFailure(
      'app.lifecycle',
      'unhandledRejection',
      'Unhandled promise rejection in the main process',
      reason instanceof Error ? reason.message : String(reason),
      'The current operation may fail and some features might not complete.',
      'Inspect the diagnostic logs and retry the failed action.',
      {
        reason: reason instanceof Error
          ? { name: reason.name, message: reason.message, stack: reason.stack }
          : String(reason),
      },
    )
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    logInfo('app.lifecycle', 'window.created', 'Main window created', {
      currentStatus: 'A browser window has been created.',
      impact: 'The renderer can begin loading and user interaction becomes available.',
      suggestion: 'No action is needed.',
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
    logInfo('config', 'read', 'Read engine configuration', {
      currentStatus: 'The latest engine config has been loaded from disk.',
      impact: 'The settings view is showing the most recently saved values.',
      suggestion: 'Review and save changes if updates are needed.',
    })
    return config
  })

  ipcMain.handle('config:save', (_, data: unknown) => {
    ensureDir(HARNESSCLAW_DIR)
    const result = saveEngineConfig(data)
    if (result.ok) {
      logInfo('config', 'save', 'Saved engine configuration', {
        currentStatus: 'Engine config has been written to disk.',
        impact: 'The next runtime apply or restart will use the updated settings.',
        suggestion: 'Apply or restart the runtime if the change should take effect immediately.',
      })
    } else {
      logFailure(
        'config',
        'save',
        'Failed to save engine configuration',
        result.error || 'Unknown config save error.',
        'The new runtime settings were not persisted and the previous config remains active.',
        'Validate the config payload and local file permissions, then retry.',
        { config: sanitizeForLogging(asRecord(data)) },
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
      logInfo('config', 'apply', 'Applied app configuration', {
        currentStatus: 'Application settings have been updated.',
        impact: 'Runtime status and logging preferences now reflect the new config.',
        suggestion: 'If connection settings changed, confirm the runtime reconnects as expected.',
      })
    } else {
      logFailure(
        'config',
        'apply',
        'Failed to apply app configuration',
        result.error || 'Unknown app config save error.',
        'The app continues using the previous settings.',
        'Validate the config payload and retry saving the settings.',
        { config: sanitizeForLogging(asRecord(data)) },
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

  // Skills reader and market
  ipcMain.handle('skills:list', () => {
    return listInstalledSkills()
  })

  ipcMain.handle('skills:read', (_, id: string) => {
    return readInstalledSkill(id)
  })

  ipcMain.handle('skills:delete', (_, id: string) => {
    return deleteInstalledSkill(id)
  })

  ipcMain.handle('skills:listRepositories', () => {
    return listSkillRepositories()
  })

  ipcMain.handle('skills:saveRepository', (_, input: {
    id?: string
    name?: string
    repoUrl: string
    branch?: string
    basePath?: string
    enabled?: boolean
  }) => {
    return saveSkillRepository(input)
  })

  ipcMain.handle('skills:removeRepository', (_, id: string) => {
    return removeSkillRepository(id)
  })

  ipcMain.handle('skills:discover', (_, repositoryId?: string) => {
    return discoverSkills(repositoryId)
  })

  ipcMain.handle('skills:listDiscovered', (_, repositoryId?: string) => {
    return listDiscoveredSkills(repositoryId)
  })

  ipcMain.handle('skills:previewDiscovered', (_, repositoryId: string, skillPath: string) => {
    return previewDiscoveredSkill(repositoryId, skillPath)
      .catch((error) => {
        console.error('[Skills] Failed to preview discovered skill:', error)
        return ''
      })
  })

  ipcMain.handle('skills:installDiscovered', (_, repositoryId: string, skillPath: string) => {
    return installDiscoveredSkill(repositoryId, skillPath)
  })

  // Start bundled harnessclaw engine, then connect Harnessclaw (auto-retries until engine is ready)
  startHarnessclawEngine()
  try {
    getDb()
    logInfo('storage.db', 'init', 'Database initialized successfully', {
      currentStatus: 'Session and usage storage is ready.',
      impact: 'History, usage tracking, and persisted metadata can be read and written.',
      suggestion: 'No action is needed.',
    })
  } catch (error) {
    logFailure(
      'storage.db',
      'init',
      'Database initialization failed',
      error instanceof Error ? error.message : String(error),
      'Sessions, history, or usage data may fail to persist.',
      'Check local disk permissions and database file integrity.',
      { error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) },
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
  logInfo('app.lifecycle', 'quit', 'Application shutdown started', {
    currentStatus: 'Shutdown cleanup is in progress.',
    impact: 'Windows, runtime processes, and database handles will be closed.',
    suggestion: 'No action is needed.',
  })
  harnessclawClient.disconnect()
  stopHarnessclawEngine()
  closeDb()
})
