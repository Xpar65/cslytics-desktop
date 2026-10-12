# `@cslytics/desktop`

The Windows Electron application: a window, a preload bridge, a main process, and one supervised
utility process that owns the engine and the SQLite file.

```powershell
pnpm dev               # electron-vite dev server
pnpm build             # produces apps/desktop/out, which every journey runs against
pnpm package:desktop   # the unsigned installers (web and full), the app package and win-unpacked, in apps/desktop/dist
pnpm smoke:packaged    # starts the packaged app and proves it opens a record and resolves its dependencies
```

`electron-builder.config.mjs` is the installer and the update feed; `src/main/release/` is the
profile pin, the version header, the stop switch and the updater. What they decide, and why it is
permanent once a public build ships, is the [desktop release plan](../../cslytics-app-docs/plans/desktop-release-plan.md).
With Cursor open on the repository, package into a folder outside it (`CSLYTICS_PACKAGE_DIR`):
something indexing the workspace holds the freshly extracted `default_app.asar` open, and
electron-builder then fails renaming `win-unpacked.tmp` with EPERM.

## The four parts, and who may do what

| Part | Owns | Must never |
|---|---|---|
| `renderer/` | what a person sees, and selection | reach the network, the filesystem or SQL directly |
| `preload/` | one typed, allowlisted bridge | expose a generic invoke |
| `main/` | windows, the single-writer lock, the credential vault, updates and the stop switch | write the trading database |
| `main/runtime/engine-runtime.ts` → utility process | the engine, and every SQLite write | hold a transaction across a remote wait |

`shared/api.ts` is the narrowest waist in the application: every command the renderer can send is
declared there as a schema and validated on arrival. A button that does nothing is almost always a
missing `case` in `engine-runtime.ts`'s `dispatch`, or a schema that rejected the payload —
[CODE-INDEX.md](../../CODE-INDEX.md) has the row.

## Rules

- One Engine Runtime per profile. `runtime-lock.ts` makes a second instance refuse rather than
  corrupt, and closing the window terminates the runtime (AUTH-08, SYS-01).
- The renderer reads SQLite projections, never Steam. Sign-in is a dialog over the shell, never the
  front door, so the window opens on cached data with nothing connected.
- No test mode, no fake-adapter switch, no "crash here" parameter in the shipped main. The
  synthetic performance harness is a separate test-only main that reuses this preload, renderer
  bundle and IPC schema.
- Styling follows the [style guide](../../cslytics-app-docs/style-guide.md). `renderer/tokens.css`
  holds the design tokens; nothing hardcodes a colour beside them. The desktop adds what a window
  needs and a Steam-page panel did not: a motion scale (every transition honours
  `prefers-reduced-motion`), an inline icon set in `renderer/components/Icon.tsx` (the CSP allows
  no remote asset), and name-derived account avatars. `renderer/lib/labels.ts` turns every engine
  code into words before it reaches the screen; a raw enum on screen is a bug.
