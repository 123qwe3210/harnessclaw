type Unsubscribe = () => void

function noopUnsubscribe(): Unsubscribe {
  return () => {}
}

function ensureBrowserMocks(): void {
  if (typeof window === 'undefined') return
  if ((window as typeof window & { harnessclaw?: unknown }).harnessclaw) return

  const appRuntime = {
    getStatus: async () => ({
      localService: 'ready' as const,
      transport: 'connected' as const,
      llmConfigured: false,
      applyingConfig: false,
    }),
    getLogLevel: async () => 'info' as const,
    getLogs: async () => ({ items: [], cursor: null, logDir: '' }),
    getDiagnosticEvents: async () => ({ items: [], cursor: null, logDir: '' }),
    getDiagnosticSummary: async () => ({ items: [] }),
    getAvailableLogDomains: async () => [],
    openLogsDirectory: async () => ({ ok: true, path: '' }),
    clearLogs: async () => ({ ok: true, cleared: [] }),
    logRenderer: async () => ({ ok: true }),
    trackUsage: async () => ({ ok: true }),
    exportData: async () => ({ ok: true, path: '' }),
    onStatus: (_callback: (status: Record<string, unknown>) => void): Unsubscribe => noopUnsubscribe(),
  }

  const engineConfig = {
    read: async () => ({ providers: {} }),
    save: async (_data: unknown) => ({ ok: true }),
  }

  const appBridge = {
    isFirstLaunch: async () => false,
    markLaunched: async () => ({ ok: true }),
    checkForUpdates: async () => ({ ok: true }),
  }

  const harnessclaw = {
    connect: async () => ({ ok: true }),
    disconnect: async () => ({ ok: true }),
    send: async (_content: string, _sessionId?: string) => ({ ok: true }),
    command: async (_cmd: string, _sessionId?: string) => ({ ok: true }),
    stop: async (_sessionId?: string) => ({ ok: true }),
    subscribe: async (_sessionId: string) => ({ ok: true }),
    unsubscribe: async (_sessionId: string) => ({ ok: true }),
    listSessions: async () => ({ ok: true }),
    probe: async () => ({ ok: true }),
    respondPermission: async (
      _requestId: string,
      _approved: boolean,
      _scope?: 'once' | 'session',
      _message?: string,
    ) => ({ ok: true }),
    getStatus: async () => ({ status: 'connected', clientId: 'browser-mock', sessionId: 'demo-session', subscriptions: [] }),
    onStatus: (_callback: (status: string) => void): Unsubscribe => noopUnsubscribe(),
    onEvent: (_callback: (event: Record<string, unknown>) => void): Unsubscribe => noopUnsubscribe(),
  }

  const skills = {
    list: async () => [],
    read: async (_id: string) => '',
    delete: async (_id: string) => ({ ok: true }),
  }

  const db = {
    listSessions: async () => [],
    getMessages: async (_sessionId: string) => [],
    deleteSession: async (_sessionId: string) => ({ ok: true }),
  }

  const files = {
    pick: async () => [],
    resolve: async (_paths: string[]) => [],
  }

  const win = window as typeof window & Record<string, unknown>
  win.electron = {}
  win.api = {}
  win.appBridge = appBridge
  win.engineConfig = engineConfig
  win.config = engineConfig
  win.nanobotConfig = engineConfig
  win.appConfig = engineConfig
  win.appRuntime = appRuntime
  win.harnessclaw = harnessclaw
  win.skills = skills
  win.db = db
  win.files = files
}

ensureBrowserMocks()
