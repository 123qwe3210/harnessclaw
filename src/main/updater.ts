import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import { recordFailure, recordMilestone } from './logging'

const { autoUpdater } = electronUpdater

const STARTUP_CHECK_DELAY_MS = 10_000
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let initialized = false
let checkInFlight = false
let periodicCheckTimer: ReturnType<typeof setInterval> | null = null
let promptInFlight = false
let downloadedVersion = ''

function sendUpdateEvent(window: BrowserWindow, type: string, payload: Record<string, unknown> = {}): void {
  if (window.isDestroyed()) return
  window.webContents.send('app:update-event', { type, ...payload })
}

async function showDownloadPrompt(window: BrowserWindow, version: string): Promise<void> {
  if (promptInFlight || window.isDestroyed()) return
  promptInFlight = true
  try {
    const result = await dialog.showMessageBox(window, {
      type: 'info',
      buttons: ['下载更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: `发现新版本 ${version}`,
      detail: '是否现在下载并安装更新？',
      noLink: true,
    })

    if (result.response === 0) {
      sendUpdateEvent(window, 'download-started', { version })
      await autoUpdater.downloadUpdate()
    } else {
      sendUpdateEvent(window, 'download-deferred', { version })
    }
  } finally {
    promptInFlight = false
  }
}

async function showInstallPrompt(window: BrowserWindow, version: string): Promise<void> {
  if (promptInFlight || window.isDestroyed()) return
  promptInFlight = true
  try {
    const result = await dialog.showMessageBox(window, {
      type: 'info',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '更新已准备完成',
      message: `版本 ${version} 已下载完成`,
      detail: '重启应用后将安装更新。',
      noLink: true,
    })

    if (result.response === 0) {
      autoUpdater.quitAndInstall()
    }
  } finally {
    promptInFlight = false
  }
}

async function checkForUpdates(window: BrowserWindow): Promise<void> {
  if (!app.isPackaged || checkInFlight || window.isDestroyed()) return
  checkInFlight = true
  try {
    sendUpdateEvent(window, 'checking')
    recordMilestone({
      domain: 'app.lifecycle',
      action: 'update.check',
      summary: '已开始检查应用更新',
      source: 'updater',
      details: {
        currentStatus: '更新检查进行中',
        impact: '如有新版本会提示下载',
        suggestion: '当前无需处理',
      },
    })
    await autoUpdater.checkForUpdates()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordFailure({
      domain: 'app.lifecycle',
      action: 'update.check',
      summary: '检查更新失败',
      source: 'updater',
      reason: message,
      impact: '不会影响当前使用，但无法得知是否有新版本',
      suggestion: '请检查网络连接后稍后重试',
    })
    sendUpdateEvent(window, 'error', { message })
  } finally {
    checkInFlight = false
  }
}

export function setupAutoUpdater(window: BrowserWindow): void {
  if (!app.isPackaged || initialized) return
  initialized = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    sendUpdateEvent(window, 'checking')
  })

  autoUpdater.on('update-available', (info) => {
    downloadedVersion = ''
    sendUpdateEvent(window, 'available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
    })
    void showDownloadPrompt(window, info.version)
  })

  autoUpdater.on('update-not-available', (info) => {
    sendUpdateEvent(window, 'not-available', { version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateEvent(window, 'download-progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    sendUpdateEvent(window, 'downloaded', { version: info.version })
    void showInstallPrompt(window, info.version)
  })

  autoUpdater.on('error', (error) => {
    const message = error == null
      ? 'Unknown auto update error'
      : error instanceof Error
        ? error.message
        : String(error)
    recordFailure({
      domain: 'app.lifecycle',
      action: 'update.error',
      summary: '自动更新流程异常',
      source: 'updater',
      reason: message,
      impact: '更新功能暂时不可用，但不影响当前版本继续运行',
      suggestion: '请稍后重试更新或查看日志排查',
    })
    sendUpdateEvent(window, 'error', { message })
  })

  window.on('closed', () => {
    if (periodicCheckTimer) {
      clearInterval(periodicCheckTimer)
      periodicCheckTimer = null
    }
    initialized = false
    promptInFlight = false
    checkInFlight = false
    downloadedVersion = ''
  })

  setTimeout(() => {
    if (!window.isDestroyed()) {
      void checkForUpdates(window)
    }
  }, STARTUP_CHECK_DELAY_MS)

  periodicCheckTimer = setInterval(() => {
    if (!window.isDestroyed()) {
      void checkForUpdates(window)
    }
  }, PERIODIC_CHECK_INTERVAL_MS)
}

export async function manuallyCheckForUpdates(window: BrowserWindow): Promise<{ ok: boolean; version?: string; error?: string }> {
  if (!app.isPackaged) {
    return { ok: false, error: 'Auto update is disabled in development mode' }
  }

  try {
    await checkForUpdates(window)
    return { ok: true, version: downloadedVersion || undefined }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
