import React, { useEffect, useState } from 'react';
import type { TransferPreview } from '@cslytics/engine';
import { Button, Caption, Field, Select } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { engine } from '../../lib/engine.js';
import { plural } from '../../lib/labels.js';

/** One selected row as `transfer.plan` and `transfer.submit` take it. */
export type TransferMemberInput = {
  accountId: string;
  localId: string;
  casketId?: string | null | undefined;
};

/** When Steam was last asked about a transfer, and for which accounts. */
export type TransferAsked = { scope: string; at: number } | null;

/**
 * How long one ask is reused. The engine trusts hold durations, sent offers and Community
 * tradability for five minutes, so a minute leaves a send room to arrive inside that window.
 */
const ASK_REUSE_MS = 60_000;

const scopeOf = (destination: string, sources: readonly string[]): string => [destination, ...[...sources].sort()].join('\0');

/** Electron prefixes a rejection from main; the engine's own sentence is what follows it. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i, '').trim();
}

/**
 * Renews what the engine judges a transfer on, for accounts that are signed in: the destination's
 * trade link, both inventories, the source's sent offers, Community tradability and hold durations.
 *
 * The transfer page did this behind a *Refresh transfer eligibility* button. Transfer moved into
 * Inventory without it, so every send was refused for evidence nothing had gathered ("Connect the
 * destination to obtain its trade link"). A person should not have to know those reads exist.
 *
 * Returns the accounts it could not ask for. A signed-out account is never asked for — that would
 * be a network attempt the session cannot authorise — and the plan then says what is missing.
 */
export async function askSteamForTransfer(destination: string, sources: readonly string[], asked: { current: TransferAsked }): Promise<string[]> {
  const scope = scopeOf(destination, sources);
  if (asked.current?.scope === scope && Date.now() - asked.current.at < ASK_REUSE_MS) return [];
  const connections = await engine.readConnections([destination, ...sources]);
  const signedOut = connections.filter((connection) => connection.steam.kind !== 'authenticated').map((connection) => connection.accountId);
  if (signedOut.length > 0) return signedOut;
  await window.trading.invoke({ type: 'transfer.refresh', destinationAccountId: destination, accountIds: [...sources] });
  asked.current = { scope, at: Date.now() };
  return [];
}

type Check = { key: string; preview: TransferPreview | null; signedOut: string[]; problem: string | null };

/**
 * Transfer's detail panel: the destination, then Steam's answer before the button.
 *
 * Choosing an account asks Steam and then asks the engine for a plan, and the button waits for
 * both. The plan is a preview, never an authorisation — admission recomputes it when the button
 * is pressed — but it lets a refusal be read before anything is pressed, in the engine's words.
 */
export function TransferDetail({ accounts, destination, onDestination, members, asked, accountName, submit }: {
  accounts: ReadonlyArray<{ id: string; name: string }>;
  destination: string;
  onDestination: (next: string) => void;
  members: readonly TransferMemberInput[];
  asked: { current: TransferAsked };
  accountName: (accountId: string) => string;
  /** The panel's submit button, withheld while `blocked`. */
  submit: (blocked: boolean) => React.JSX.Element;
}): React.JSX.Element {
  const [check, setCheck] = useState<Check | null>(null);
  const [again, setAgain] = useState(0);
  const key = destination ? JSON.stringify([destination, members]) : '';

  useEffect(() => {
    if (!key) return undefined;
    const [to, chosen] = JSON.parse(key) as [string, TransferMemberInput[]];
    const sources = [...new Set(chosen.map((member) => member.accountId))];
    let live = true;
    void (async () => {
      let signedOut: string[] = [];
      let problem: string | null = null;
      try {
        signedOut = await askSteamForTransfer(to, sources, asked);
      } catch (error) {
        problem = reasonOf(error);
      }
      let preview: TransferPreview | null = null;
      try {
        preview = await window.trading.invoke({
          type: 'transfer.plan', commandId: crypto.randomUUID(), destinationAccountId: to, members: chosen
        }) as TransferPreview;
      } catch (error) {
        problem ??= reasonOf(error);
      }
      if (live) setCheck({ key, preview, signedOut, problem });
    })();
    return () => { live = false; };
  }, [key, again, asked]);

  const current = check?.key === key ? check : null;
  const preview = current?.preview ?? null;
  const ready = Boolean(preview && preview.blocked.length === 0 && preview.quantity > 0);
  // One line per account and reason: a hundred items refused for the same stale hold is one fact.
  const reasons = [...new Set((preview?.blocked ?? []).map((blocked) => `${accountName(blocked.accountId)}: ${blocked.reason}`))];

  return <>
    <Field label="To account">
      <Select label="Destination account" className="input-sm" value={destination} onChange={onDestination}>
        <option value="">Choose an account…</option>
        {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
      </Select>
    </Field>
    {destination && !current ? <Caption icon="hourglass">Checking both accounts with Steam…</Caption> : null}
    {current && current.signedOut.length > 0 ? (
      <Caption icon="log-in" tone="warn">Sign in to {current.signedOut.map(accountName).join(' and ')} so Steam can be asked about this transfer.</Caption>
    ) : null}
    {current?.problem ? <Caption icon="alert-triangle" tone="warn">Steam could not be asked: {current.problem}</Caption> : null}
    {ready ? (
      <Caption icon="check-circle" tone="positive">
        Ready: {plural(preview!.quantity, 'item')} in {plural(preview!.groups.length, 'offer')}
        {preview!.retrievals > 0 ? `; ${preview!.retrievals} retrieved from storage first` : ''}. Each offer is confirmed on the sending account’s phone.
      </Caption>
    ) : null}
    {reasons.length > 0 ? (
      <ul className="transfer-refusals" aria-label="Why this transfer cannot be sent">
        {reasons.map((reason) => <li key={reason}><Icon name="ban" size={12} /><span>{reason}</span></li>)}
      </ul>
    ) : null}
    {current && !ready ? (
      <Button size="sm" variant="ghost" icon="refresh" onClick={() => { asked.current = null; setCheck(null); setAgain((count) => count + 1); }}>Check again</Button>
    ) : null}
    {submit(!ready)}
  </>;
}
