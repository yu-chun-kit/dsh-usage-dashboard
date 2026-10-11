type RuntimeReact = {
  readonly createElement?: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
  readonly useState?: <T>(initial: T) => [T, (value: T | ((previous: T) => T)) => void]
}

function reactRuntime(): RuntimeReact | undefined {
  const candidate = (globalThis as { readonly React?: RuntimeReact }).React
  return candidate
}

/** Optional React bridge: Harness supplies React in the browser bundle; tests stay dependency-free. */
export function createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown {
  return reactRuntime()?.createElement?.(type, props, ...children) ?? { type, props, children }
}

export function useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void] {
  const hook = reactRuntime()?.useState
  if (hook !== undefined) return hook(initial)
  let current = initial
  return [current, (value) => { current = typeof value === 'function' ? (value as (previous: T) => T)(current) : value }]
}
