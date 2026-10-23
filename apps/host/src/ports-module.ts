import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HostPorts } from './host.js';

/** What a ports module is told when the host asks it for ports. */
export type PortsModuleContext = {
  /** The record the host is about to open, so a module can keep its own files beside it. */
  record: string;
  env: NodeJS.ProcessEnv;
  /** Everything after `--` on the host's command line, for the module's own options. */
  args: readonly string[];
  log: (line: string) => void;
};

export type PortsModule = (context: PortsModuleContext) => Promise<HostPorts>;

/**
 * Loads the module that composes the ports: a file path, or a package specifier the host's
 * resolution can find. The module exports `createPorts` or a default export of that shape.
 *
 * This is the whole of how the host chooses venue implementations. It does not import an
 * adapter itself, so a server whose Steam sessions come from somewhere the desktop's adapters
 * do not know about composes its own module and the host is unchanged — which is also what keeps
 * a deterministic twin of the venues one `--ports` away for a rehearsal.
 */
export async function loadPortsModule(specifier: string): Promise<PortsModule> {
  const looksLikePath = specifier.startsWith('.') || isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier) || /\.(c|m)?(j|t)s$/.test(specifier);
  const target = looksLikePath ? pathToFileURL(resolve(specifier)).href : specifier;
  const loaded = await import(target) as { createPorts?: unknown; default?: unknown };
  const candidate = loaded.createPorts ?? loaded.default;
  if (typeof candidate !== 'function') throw new Error(`${specifier} exports neither createPorts nor a default function`);
  return candidate as PortsModule;
}
