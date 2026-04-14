import { WebSocket } from 'ws'
import { createPrivateKey, createPublicKey, sign, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { recordFailure, recordMilestone, recordRetry } from './logging'

interface DeviceCredentials {
  deviceId: string
  privateKeyPem: string
  publicKeyPem: string
  token: string
}

interface GatewayRequest {
  type: 'req'
  id: string
  method: string
  params: Record<string, unknown>
}

interface GatewayResponse {
  type: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: { code: string; message: string }
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null
  private credentials: DeviceCredentials | null = null
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void; timer: NodeJS.Timeout }
  >()
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private authFailed = false
  private status: ConnectionStatus = 'disconnected'
  private heartbeatTimer: NodeJS.Timeout | null = null

  public gatewayUrl = 'ws://127.0.0.1:18789'

  constructor() {
    super()
    this.loadCredentials()
  }

  private loadCredentials(): void {
    try {
      const devicePath = join(homedir(), '.clawdbot', 'identity', 'device.json')
      const authPath = join(homedir(), '.clawdbot', 'identity', 'device-auth.json')

      const device = JSON.parse(readFileSync(devicePath, 'utf-8'))
      const auth = JSON.parse(readFileSync(authPath, 'utf-8'))

      this.credentials = {
        deviceId: device.deviceId,
        privateKeyPem: device.privateKeyPem,
        publicKeyPem: device.publicKeyPem,
        token: auth.tokens?.operator?.token || ''
      }
      recordMilestone({
        domain: 'runtime.gateway',
        action: 'credentials.loaded',
        summary: 'Gateway 凭证已加载',
        source: 'gateway',
        details: {
          currentStatus: '连接前置凭证已就绪',
          impact: '可以继续发起 gateway 连接',
          suggestion: '当前无需处理',
          deviceIdPreview: `${device.deviceId.slice(0, 8)}...`,
        },
      })
    } catch (e) {
      recordFailure({
        domain: 'runtime.gateway',
        action: 'credentials.load',
        summary: 'Gateway 凭证加载失败',
        source: 'gateway',
        reason: e instanceof Error ? e.message : String(e),
        impact: 'gateway 连接不可用',
        suggestion: '请检查本地 identity 目录与凭证文件',
        details: { error: e },
      })
    }
  }

  private getPublicKeyB64(): string {
    if (!this.credentials) throw new Error('No credentials')
    const pubKey = createPublicKey(this.credentials.publicKeyPem)
    const der = pubKey.export({ type: 'spki', format: 'der' }) as Buffer
    const rawKey = der.slice(-32)
    return rawKey.toString('base64url')
  }

  private signNonce(nonce: string): string {
    if (!this.credentials) throw new Error('No credentials')
    const privateKey = createPrivateKey(this.credentials.privateKeyPem)
    const message = Buffer.from(nonce, 'utf8')
    const signature = sign(null, message, { key: privateKey })
    return signature.toString('base64url')
  }

  connect(): void {
    if (this.status === 'connected' || this.status === 'connecting') return
    if (!this.credentials) {
      recordFailure({
        domain: 'runtime.gateway',
        action: 'connect',
        summary: 'Gateway 连接失败：未找到凭证',
        source: 'gateway',
        reason: 'credentials unavailable',
        impact: 'gateway 相关功能不可用',
        suggestion: '请先完成本地配对或检查凭证文件',
      })
      this.setStatus('disconnected')
      return
    }
    this.authFailed = false
    this.setStatus('connecting')
    this.createConnection()
  }

  private createConnection(): void {
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.close()
    }

    recordMilestone({
      domain: 'comm.websocket',
      action: 'gateway.connect',
      summary: '正在连接 Gateway',
      source: 'gateway',
      details: {
        currentStatus: '连接进行中',
        impact: '连接成功后可使用 gateway 能力',
        suggestion: '如持续失败，请检查 gateway 服务是否可达',
        url: this.gatewayUrl,
      },
    })
    this.ws = new WebSocket(this.gatewayUrl)

    this.ws.on('open', () => {
      recordMilestone({
        domain: 'comm.websocket',
        action: 'gateway.connected',
        summary: 'Gateway websocket 已连接，等待鉴权挑战',
        source: 'gateway',
        details: {
          currentStatus: '连接已建立，鉴权进行中',
          impact: '完成 challenge 后才能正式使用 gateway',
          suggestion: '当前无需处理',
        },
      })
      this.reconnectAttempts = 0
    })

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        this.handleMessage(msg)
      } catch (e) {
        recordFailure({
          domain: 'comm.websocket',
          action: 'gateway.parse',
          summary: 'Gateway 消息解析失败',
          source: 'gateway',
          reason: e instanceof Error ? e.message : String(e),
          impact: '当前消息无法处理，连接状态可能不一致',
          suggestion: '请检查 gateway 服务端输出',
          details: { error: e },
        })
      }
    })

    this.ws.on('error', (err) => {
      recordFailure({
        domain: 'comm.websocket',
        action: 'gateway.error',
        summary: `Gateway 连接失败：${err.message}`,
        source: 'gateway',
        reason: err.message,
        impact: 'gateway 连接暂时不可用',
        suggestion: '请检查 gateway 服务是否正常运行',
        details: { error: err },
      })
    })

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason.toString()
      recordFailure({
        domain: 'comm.websocket',
        action: 'gateway.closed',
        summary: 'Gateway 连接已关闭',
        source: 'gateway',
        reason: `close code ${code} ${reasonStr}`.trim(),
        impact: 'gateway 功能暂时不可用',
        suggestion: code === 1008 ? '请检查设备签名与鉴权信息' : '系统会自动重连，请稍候',
        details: { code, reason: reasonStr },
      })
      this.setStatus('disconnected')
      this.stopHeartbeat()
      // 1008 = policy violation (device signature invalid) — permanent auth failure, don't retry
      if (code === 1008) {
        recordFailure({
          domain: 'runtime.gateway',
          action: 'auth.failed',
          summary: 'Gateway 鉴权失败，系统不会继续重连',
          source: 'gateway',
          reason: reasonStr || 'policy violation',
          impact: 'gateway 功能不可用，需人工修复',
          suggestion: '请检查设备凭证和签名配置',
          details: { code, reason: reasonStr },
        })
        this.authFailed = true
        return
      }
      this.scheduleReconnect()
    })
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string

    if (type === 'event') {
      const event = msg.event as string

      if (event === 'connect.challenge') {
        this.handleChallenge(msg.payload as { nonce: string; ts: number })
        return
      }

      this.emit('event', msg)
      return
    }

    if (type === 'res') {
      const res = msg as unknown as GatewayResponse
      const pending = this.pendingRequests.get(res.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(res.id)
        if (res.ok) {
          pending.resolve(res.payload)
        } else {
          pending.reject(new Error(res.error?.message || 'Request failed'))
        }
      }
    }
  }

  private handleChallenge(payload: { nonce: string; ts: number }): void {
    if (!this.credentials) {
      console.error('[Gateway] No credentials for challenge, giving up')
      this.authFailed = true
      this.ws?.close()
      this.setStatus('disconnected')
      return
    }

    const { nonce } = payload
    const signedAt = Date.now()

    try {
      const signature = this.signNonce(nonce)
      const publicKey = this.getPublicKeyB64()

      const connectRequest: GatewayRequest = {
        type: 'req',
        id: randomUUID(),
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'clawdbot-control-ui',
            version: '1.0.0',
            platform: process.platform,
            mode: 'webchat'
          },
          device: {
            id: this.credentials.deviceId,
            publicKey,
            signature,
            signedAt,
            nonce
          },
          role: 'operator',
          scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
          caps: [],
          auth: {
            token: this.credentials.token
          },
          userAgent: `Electron/openclaw-nanny (${process.platform})`,
          locale: 'zh-CN'
        }
      }

      this.ws?.send(JSON.stringify(connectRequest))

      this.waitForResponse(connectRequest.id, 10000)
        .then((response) => {
          recordMilestone({
            domain: 'runtime.gateway',
            action: 'ready',
            summary: 'Gateway 已连接并完成鉴权',
            source: 'gateway',
            details: {
              currentStatus: 'gateway 已就绪',
              impact: '相关远程能力可以正常使用',
              suggestion: '当前无需处理',
            },
          })
          this.setStatus('connected')
          this.startHeartbeat()
          this.emit('connected', response)
        })
        .catch((e) => {
          recordFailure({
            domain: 'runtime.gateway',
            action: 'connect',
            summary: 'Gateway 连接失败',
            source: 'gateway',
            reason: e instanceof Error ? e.message : String(e),
            impact: 'gateway 功能暂时不可用',
            suggestion: '系统会自动重连，请检查网络与服务状态',
            details: { error: e },
          })
          this.setStatus('disconnected')
          this.scheduleReconnect()
        })
    } catch (e) {
      recordFailure({
        domain: 'runtime.gateway',
        action: 'challenge',
        summary: 'Gateway 鉴权挑战处理失败',
        source: 'gateway',
        reason: e instanceof Error ? e.message : String(e),
        impact: 'gateway 无法完成连接',
        suggestion: '请检查本地凭证与服务端挑战格式',
        details: { error: e },
      })
      this.setStatus('disconnected')
      this.scheduleReconnect()
    }
  }

  private waitForResponse(id: string, timeout = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error('Request timeout'))
      }, timeout)
      this.pendingRequests.set(id, { resolve, reject, timer })
    })
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.status !== 'connected') {
      throw new Error('Not connected to Gateway')
    }

    const id = crypto.randomUUID()
    const request: GatewayRequest = { type: 'req', id, method, params }

    this.ws?.send(JSON.stringify(request))
    return this.waitForResponse(id)
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status
    this.emit('statusChange', status)
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  private scheduleReconnect(): void {
    if (this.authFailed) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      recordFailure({
        domain: 'runtime.gateway',
        action: 'retry',
        summary: 'Gateway 已达到最大重连次数',
        source: 'gateway',
        reason: `retries exhausted: ${this.maxReconnectAttempts}`,
        impact: 'gateway 连接不会再自动恢复',
        suggestion: '请检查 gateway 服务后手动重启应用或重新连接',
      })
      return
    }

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    recordRetry({
      domain: 'runtime.gateway',
      action: 'retry',
      summary: `Gateway 连接失败：系统将在 ${delay}ms 后自动重试`,
      source: 'gateway',
      retryInMs: delay,
      reason: '连接尚未恢复',
      impact: '在重连成功前，gateway 功能不可用',
      suggestion: '请检查 gateway 服务状态',
    })

    this.setStatus('reconnecting')
    this.reconnectTimer = setTimeout(() => {
      if (!this.authFailed) this.createConnection()
    }, delay)
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.request('ping', {}).catch(() => {})
      }
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.stopHeartbeat()
    this.ws?.close()
    this.setStatus('disconnected')
  }
}

export const gatewayClient = new GatewayClient()
