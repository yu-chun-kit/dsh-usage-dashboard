import { UsageDashboardController } from './controller.js'
import type { ClientRpcConnection } from './controller.js'
import { normalizeDashboardLocale, renderDashboardHtml } from './render.js'
import { settingsText } from './settings.js'
import type { ProviderId } from '../core/types.js'
import { createElement, useState } from './runtime.js'

export const DASHBOARD_TAB_ID = 'dsh-usage-dashboard'
export const DASHBOARD_BODY_SLOT = 'sidebar.right.pane.tab'

export interface ClientSlotRegistry {
  register(slot: unknown, component: unknown): unknown
  inject?(slot: string, factory: () => unknown): unknown
}

export interface UsageDashboardClientContext {
  readonly connection: ClientRpcConnection
  readonly slots: ClientSlotRegistry
  readonly sidebarRightTabs: {
    register(definition: { id: string; kind: string; title: () => string; guide: readonly { id: string; order: number; title: () => string }[] }): unknown
  }
  readonly effect: (callback: () => unknown, label?: string) => unknown
  readonly providerIds?: readonly ProviderId[]
  readonly refreshTtlMinutes?: number
  readonly locale?: 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | string
}

function resolveLocale(value: unknown): 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' {
  return typeof value === 'string' ? normalizeDashboardLocale(value) : 'en'
}

function dockComponent(ctx: UsageDashboardClientContext): unknown {
  return function UsageDashboardDockView(): unknown {
    const [controller] = useState(new UsageDashboardController(ctx.connection, ctx.providerIds ?? [], ctx.refreshTtlMinutes ?? 15))
    const [, setVersion] = useState(0)
    const state = controller.state()
    const eventHandler = async (event: { readonly target?: { closest?: (selector: string) => unknown } }): Promise<void> => {
      const target = event.target?.closest?.('[data-dsw-action]') as { getAttribute?: (name: string) => string | null } | null
      const action = target?.getAttribute?.('data-dsw-action')
      if (action === 'toggle') await controller.toggle()
      if (action === 'refresh') await controller.refresh(true)
      setVersion((version) => version + 1)
    }
    return createElement('div', {
      'data-dsh-usage-dashboard-host': true,
      onClick: eventHandler,
      dangerouslySetInnerHTML: { __html: renderDashboardHtml(state, resolveLocale(ctx.locale)).replace('class="dsw-dashboard__toggle"', 'class="dsw-dashboard__toggle" data-dsw-action="toggle"').replace('class="dsw-dashboard__refresh"', 'class="dsw-dashboard__refresh" data-dsw-action="refresh"') },
    })
  }
}

export function registerClientSlots(ctx: UsageDashboardClientContext): void {
  const title = () => settingsText[resolveLocale(ctx.locale)].title
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: DASHBOARD_TAB_ID, kind: DASHBOARD_TAB_ID, title, guide: [{ id: DASHBOARD_TAB_ID, order: 44, title }] }), 'dsh-usage-dashboard: official sidebar tab')
  const body = () => ctx.slots.register({ name: DASHBOARD_BODY_SLOT, key: DASHBOARD_TAB_ID }, dockComponent(ctx))
  ctx.effect(() => ctx.slots.inject === undefined ? body() : ctx.slots.inject(DASHBOARD_BODY_SLOT, body), 'dsh-usage-dashboard: official sidebar body')
}

export function applyClient(ctx: UsageDashboardClientContext): void {
  registerClientSlots(ctx)
}

export default applyClient
