/**
 * Asset imports, as Vite resolves them.
 *
 * Both marks are small enough that Vite inlines them as `data:` URIs rather than emitting a file,
 * which is why the renderer can show them under a CSP that allows `data:` and nothing remote.
 * Declared here rather than by pulling in `vite/client`, which would also declare `import.meta.env`
 * and a `fetch`-shaped world the renderer is deliberately not given (SYS-03).
 */
declare module '*.png' {
  const source: string;
  export default source;
}

declare module '*.svg' {
  const source: string;
  export default source;
}
