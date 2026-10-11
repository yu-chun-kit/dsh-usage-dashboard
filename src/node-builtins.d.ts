/**
 * Minimal local declarations for the Node builtins the host half uses.
 *
 * The project intentionally has no `@types/node` dependency, and the
 * diagnostic write is best-effort (see `recordBootOutcome`), so only the
 * signature actually used is declared here.
 */
declare module 'node:fs' {
  export function appendFileSync(path: string, data: string): void
}
declare module 'node:os' {
  export function tmpdir(): string
}
declare module 'node:path' {
  export function join(...paths: string[]): string
}
