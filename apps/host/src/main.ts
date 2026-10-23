import { parseArgs } from 'node:util';
import { createHost, type HostAccount } from './host.js';
import { serveHost } from './http.js';
import { loadPortsModule } from './ports-module.js';

const USAGE = `cslytics-host — the engine, headless, over HTTP

  cslytics-host serve --record <file> --ports <module> [--listen 127.0.0.1:7411]
                      [--account id:steamId64:name]... [--connect id]... [--active id] [--no-cs2]
                      [-- <options for the ports module>]
  cslytics-host exec '<json command>'            one runtime command; prints the answer as JSON
  cslytics-host exec <type> [--json '{...}']      the same, with the type given on its own
  cslytics-host events                            prints change notices as they arrive
  cslytics-host stop                              asks a serving host to close

The token is CSLYTICS_HOST_TOKEN in the environment, for serving and for every client call. The
client's address is CSLYTICS_HOST_URL or --url (default http://127.0.0.1:7411).`;

async function main(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv;
  switch (verb) {
    case 'serve': return serve(rest);
    case 'exec': return exec(rest);
    case 'events': return events(rest);
    case 'stop': return stop(rest);
    default:
      console.error(USAGE);
      return verb === undefined || verb === '--help' || verb === '-h' ? 0 : 2;
  }
}

function token(): string {
  const value = process.env.CSLYTICS_HOST_TOKEN;
  if (!value) throw new Error('CSLYTICS_HOST_TOKEN is not set');
  return value;
}

function baseUrl(given: string | undefined): string {
  return (given ?? process.env.CSLYTICS_HOST_URL ?? 'http://127.0.0.1:7411').replace(/\/$/, '');
}

async function serve(args: readonly string[]): Promise<number> {
  const separator = args.indexOf('--');
  const own = separator === -1 ? args : args.slice(0, separator);
  const forModule = separator === -1 ? [] : args.slice(separator + 1);
  const { values } = parseArgs({
    args: [...own],
    options: {
      record: { type: 'string' },
      ports: { type: 'string' },
      listen: { type: 'string', default: '127.0.0.1:7411' },
      account: { type: 'string', multiple: true, default: [] },
      connect: { type: 'string', multiple: true, default: [] },
      active: { type: 'string' },
      'no-cs2': { type: 'boolean', default: false }
    },
    strict: true
  });
  if (!values.record || !values.ports) {
    console.error(USAGE);
    return 2;
  }
  const accounts: HostAccount[] = values.account.map((spec) => {
    const [accountId, steamId64, ...name] = spec.split(':');
    if (!accountId || !steamId64 || name.length === 0) throw new Error(`--account wants id:steamId64:name, got ${spec}`);
    return { accountId, steamId64, accountName: name.join(':') };
  });
  const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
  const createPorts = await loadPortsModule(values.ports);
  const ports = await createPorts({ record: values.record, env: process.env, args: forModule, log });
  const host = await createHost({
    record: values.record,
    ports,
    accounts,
    connect: values.connect,
    cs2: !values['no-cs2'],
    active: values.active ?? null,
    log
  });
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      log('closing');
      await serving.close();
      await host.close();
    })();
    return closing;
  };
  const serving = await serveHost(host, { listen: values.listen, token: token(), onShutdown: () => { void close().then(() => process.exit(0)); } });
  log(`listening on ${serving.address}; record ${values.record}; accounts ${host.accounts().map((row) => row.id).join(', ') || 'none'}`);
  const stopOnSignal = (): void => { void close().then(() => process.exit(0)); };
  process.on('SIGINT', stopOnSignal);
  process.on('SIGTERM', stopOnSignal);
  await new Promise<void>(() => undefined);
  return 0;
}

async function exec(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: 'string' }, url: { type: 'string' } },
    allowPositionals: true,
    strict: true
  });
  const [first] = positionals;
  if (!first) {
    console.error(USAGE);
    return 2;
  }
  const command = first.trimStart().startsWith('{')
    ? JSON.parse(first) as Record<string, unknown>
    : { type: first, ...(values.json ? JSON.parse(values.json) as Record<string, unknown> : {}) };
  const response = await fetch(`${baseUrl(values.url)}/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: JSON.stringify(command)
  });
  const text = await response.text();
  console.log(text);
  if (!response.ok) return 1;
  try {
    return (JSON.parse(text) as { ok?: boolean }).ok ? 0 : 1;
  } catch {
    return 1;
  }
}

async function events(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { url: { type: 'string' } }, strict: true });
  const response = await fetch(`${baseUrl(values.url)}/events`, { headers: { authorization: `Bearer ${token()}` } });
  if (!response.ok || !response.body) {
    console.error(`events: ${response.status} ${await response.text()}`);
    return 1;
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let boundary = buffered.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) console.log(data.slice('data: '.length));
      boundary = buffered.indexOf('\n\n');
    }
  }
  return 0;
}

async function stop(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { url: { type: 'string' } }, strict: true });
  const response = await fetch(`${baseUrl(values.url)}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token()}` } });
  console.log(await response.text());
  return response.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => { if (code !== 0) process.exitCode = code; },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
