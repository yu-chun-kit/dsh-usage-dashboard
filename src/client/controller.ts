import type { ProviderId, UsageDashboardSnapshot, PublicUsageError } from '../core/types.js'
import type { RpcResult } from '../core/rpc.js'

export interface ClientRpcConnection {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

export interface DashboardClientState {
  readonly expanded: boolean
  readonly loading: boolean
  readonly snapshot?: UsageDashboardSnapshot
  readonly error?: string
  readonly errorCode?: PublicUsageError['code']
  readonly lastLoadedAt?: number
}

export class UsageDashboardController {
  private current: DashboardClientState = { expanded: false, loading: false }
  private pending?: Promise<void>
  private providerIds: readonly ProviderId[]

  constructor(
    private readonly connection: ClientRpcConnection,
    providerIds: readonly ProviderId[] = [],
    private readonly ttlMinutes = 15,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.providerIds = [...providerIds]
  }

  state(): DashboardClientState {
    return this.current
  }

  setProviders(providerIds: readonly ProviderId[]): void {
    this.providerIds = [...providerIds]
  }

  async toggle(): Promise<void> {
    if (this.current.expanded) {
      this.current = { ...this.current, expanded: false }
      return
    }
    this.current = { ...this.current, expanded: true }
    await this.ensureFresh()
  }

  async expand(): Promise<void> {
    if (!this.current.expanded) this.current = { ...this.current, expanded: true }
    await this.ensureFresh()
  }

  collapse(): void {
    this.current = { ...this.current, expanded: false }
  }

  async refresh(force = false): Promise<void> {
    if (this.pending !== undefined) return this.pending
    this.current = { ...this.current, loading: true, error: undefined, errorCode: undefined }
    this.pending = this.load(force)
    try {
      await this.pending
    } finally {
      this.pending = undefined
    }
  }

  private async ensureFresh(): Promise<void> {
    const loadedAt = this.current.lastLoadedAt
    const fresh = loadedAt !== undefined && this.now() - loadedAt < this.ttlMinutes * 60_000
    if (!fresh) await this.refresh(false)
  }

  private async load(force: boolean): Promise<void> {
    try {
      const raw = await this.connection.rpc.call('/usage-dashboard', 'snapshot', {
        providerIds: this.providerIds,
        force,
      })
      const result = raw as RpcResult<UsageDashboardSnapshot>
      if (!result || result.ok !== true) {
        this.current = { ...this.current, loading: false, error: result?.ok === false ? result.error.message : 'Usage dashboard request failed.', errorCode: result?.ok === false ? result.error.code : undefined }
        return
      }
      this.current = { ...this.current, loading: false, snapshot: result.value, error: undefined, errorCode: undefined, lastLoadedAt: this.now() }
    } catch {
      this.current = { ...this.current, loading: false, error: 'Usage dashboard request failed.', errorCode: undefined }
    }
  }
}
