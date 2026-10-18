import React, { useEffect, useMemo, useState } from 'react';
import type { StorePrecheck } from '@cslytics/engine';
import { Button, Caption } from '../../components/ui.js';
import { Tip } from '../../components/Tip.js';
import { formatRelative, plural } from '../../lib/labels.js';
import { submitCommand } from './commands.js';
import { selectionKey, type InventorySelection } from './selection.js';
import type { ActionVerdict } from './item-actions.js';
import type { NamedItem } from './InventoryTiles.js';

/** A claim the pre-check names, in the words the panel uses for it. */
const CLAIMS: Readonly<Record<StorePrecheck['decide'][number]['claim'], { one: string; many: string; consequence: string }>> = {
  'csfloat-listed': {
    one: 'is listed on CSFloat',
    many: 'are listed on CSFloat',
    consequence: 'If one sells while it is stored, the sale cannot be delivered until you retrieve it, and CSFloat may penalise the account. Delisting is yours to do on CSFloat.'
  },
  'csfloat-owed': {
    one: 'is sold on CSFloat and owed to the buyer',
    many: 'are sold on CSFloat and owed to their buyers',
    consequence: 'Storing it fails that sale\'s delivery: the buyer is not sent the item, and CSFloat may penalise the account.'
  },
  'trade-pledged': {
    one: 'is in a pending trade offer',
    many: 'are in pending trade offers',
    consequence: 'Storing it takes it out of the offer, which then cannot be accepted as it stands.'
  }
};

/** The reads a CSFloat or trade claim rests on, for the "as of" a person is shown. */
const READ_OF: Readonly<Record<StorePrecheck['decide'][number]['claim'], StorePrecheck['asOf'][number]['surface']>> = {
  'csfloat-listed': 'csfloat-stall',
  'csfloat-owed': 'csfloat-trades',
  'trade-pledged': 'steam-trade-offers'
};

type Check = { key: string; answer: StorePrecheck } | { key: string; error: string };

/**
 * Store, for a selection of any size (bulk storage plan §5).
 *
 * What cannot be stored is left out and said so, rather than withholding Store from the rest
 * (D13). When Store and a unit are chosen, the engine's pre-check is asked: it answers from what
 * the app already holds, at once, and names what will be left out, what the person decides —
 * an item listed on CSFloat, owed to a CSFloat buyer, or in a pending trade offer — how old the
 * reads behind it are, each unit's room, and whether CS2 is connected. A decision is two buttons
 * rather than a dialog: leave them out, or store them anyway (D9). Nothing is sent while CS2 is not
 * connected or a unit cannot hold the selection (D4, D12); the engine refuses either in its own
 * words if it is asked regardless.
 */
export function StoreDetail({ selection, verdicts, destinations, unitPickers, unitMissing, accountName, busy, onSent, onFailed }: {
  selection: InventorySelection;
  verdicts: ReadonlyArray<{ row: NamedItem; verdict: ActionVerdict }>;
  destinations: Record<string, string>;
  unitPickers: React.ReactNode;
  unitMissing: boolean;
  accountName: (accountId: string) => string;
  busy: boolean;
  onSent: (count: number) => void;
  onFailed: (reason: string) => void;
}): React.JSX.Element {
  const manifest = selection.manifest ?? null;
  const [check, setCheck] = useState<Check | null>(null);
  const [sending, setSending] = useState<'leave' | 'anyway' | null>(null);

  // What the panel itself can already leave out: every row the inspector says cannot be stored.
  const storable = useMemo(() => verdicts.filter(({ verdict }) => verdict.allowed.includes('STORE')).map(({ row }) => row), [verdicts]);
  const leftHere = useMemo(() => verdicts.filter(({ verdict }) => !verdict.allowed.includes('STORE'))
    .map(({ verdict }) => verdict.blocked.find((entry) => entry.kind === 'STORE')?.reason ?? 'unavailable'), [verdicts]);

  const members = useMemo(() => storable.map((row) => ({ accountId: row.accountId, localId: row.localId })), [storable]);
  const key = JSON.stringify([manifest ? [manifest.token, manifest.revision] : members.map((member) => `${member.accountId}:${member.localId}`), destinations]);
  useEffect(() => {
    if (unitMissing || (!manifest && members.length === 0)) return undefined;
    let live = true;
    window.trading.invoke({
      type: 'store.precheck',
      ...(manifest ? { manifestToken: manifest.token } : { members }),
      destinations
    }).then((answer) => { if (live) setCheck({ key, answer: answer as StorePrecheck }); })
      .catch((error: unknown) => { if (live) setCheck({ key, error: error instanceof Error ? error.message : String(error) }); });
    return () => { live = false; };
    // `key` is the whole input; the objects it was made from are new on every render.
  }, [key, unitMissing]);

  const current = check?.key === key ? check : null;
  const answer = current && 'answer' in current ? current.answer : null;
  const memberKey = (accountId: string, localId: string): string => `${accountId}\u0000${localId}`;
  const engineLeaves = new Set((answer?.leaveOut ?? []).map((line) => memberKey(line.accountId, line.localId)));
  const flagged = new Set((answer?.decide ?? []).map((line) => memberKey(line.accountId, line.localId)));
  const base = manifest ? (answer ? answer.asked - answer.leaveOut.length : 0) : members.filter((member) => !engineLeaves.has(memberKey(member.accountId, member.localId))).length;
  const leaveCount = base - flagged.size;
  const leftOut = [...leftHere, ...(answer?.leaveOut ?? []).map((line) => line.reason)];

  /** How many each option would put into each account's unit, against its room. */
  const perAccount = (includeFlagged: boolean): Map<string, number> => {
    const counts = new Map<string, number>();
    if (manifest) return counts;
    for (const member of members) {
      const at = memberKey(member.accountId, member.localId);
      if (engineLeaves.has(at) || (!includeFlagged && flagged.has(at))) continue;
      counts.set(member.accountId, (counts.get(member.accountId) ?? 0) + 1);
    }
    return counts;
  };
  const roomProblems = (includeFlagged: boolean): string[] => {
    if (!answer) return [];
    const counts = perAccount(includeFlagged);
    return answer.room.flatMap((room) => {
      const wanted = manifest ? (includeFlagged ? base : leaveCount) : counts.get(room.accountId) ?? 0;
      return wanted > room.room
        ? [`${room.label ?? `Unit ${room.casketId}`} has room for ${plural(room.room, 'more item')}; ${wanted} ${wanted === 1 ? 'is' : 'are'} selected.`]
        : [];
    });
  };
  const gcDown = answer?.gcDown ?? [];
  const blocked = busy || unitMissing || !answer || gcDown.length > 0 || sending !== null;

  async function send(includeFlagged: boolean): Promise<void> {
    if (!answer) return;
    setSending(includeFlagged ? 'anyway' : 'leave');
    try {
      const consent = includeFlagged ? [...new Set(answer.decide.map((line) => line.claim))] : [];
      const dropped = [...answer.leaveOut, ...(includeFlagged ? [] : answer.decide)];
      let chosen: InventorySelection;
      if (manifest) {
        const unique = [...new Map(dropped.map((line) => [memberKey(line.accountId, line.localId), { accountId: line.accountId, localId: line.localId }])).values()];
        const snapshot = unique.length > 0
          ? await window.trading.invoke({ type: 'selection.exclude', token: manifest.token, revision: manifest.revision, members: unique }) as NonNullable<InventorySelection['manifest']>
          : manifest;
        chosen = { rows: {}, manifest: snapshot };
      } else {
        const out = new Set(dropped.map((line) => memberKey(line.accountId, line.localId)));
        const rows = storable.filter((row) => !out.has(memberKey(row.accountId, row.localId)));
        chosen = { rows: Object.fromEntries(rows.map((row) => [selectionKey(row), { row, quantity: selection.rows[selectionKey(row)]?.quantity ?? 1 }])) };
      }
      await submitCommand('STORE', chosen, { destinations, priceCents: null, consent });
      onSent(includeFlagged ? base : leaveCount);
    } catch (error) {
      onFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(null);
    }
  }

  const claims = answer ? (Object.keys(CLAIMS) as Array<keyof typeof CLAIMS>).map((claim) => ({
    claim,
    count: new Set(answer.decide.filter((line) => line.claim === claim).map((line) => memberKey(line.accountId, line.localId))).size,
    asOf: answer.asOf.filter((row) => row.surface === READ_OF[claim]).map((row) => row.finishedAt)
  })).filter((row) => row.count > 0) : [];
  const total = base;
  const reasons = [...new Set(leftOut)].map((reason) => `${leftOut.filter((entry) => entry === reason).length} ${reason}`).join(', ');
  const leaveRoom = roomProblems(false), anywayRoom = roomProblems(true);

  return (
    <>
      {unitPickers}
      {leftOut.length > 0 ? (
        <Caption icon="info">
          <Tip content={`Left out: ${reasons}.`}>{plural(leftOut.length, 'item')} will be left out</Tip>
        </Caption>
      ) : null}
      {gcDown.length > 0 ? (
        <Caption icon="alert-triangle" tone="warn">
          CS2 is not connected for {gcDown.map(accountName).join(', ')}. Connect it to store.
        </Caption>
      ) : null}
      {(claims.length > 0 ? leaveRoom : anywayRoom).map((problem) => <Caption key={problem} icon="alert-triangle" tone="warn">{problem}</Caption>)}
      {current && 'error' in current ? <Caption icon="alert-triangle" tone="warn">Could not check this selection: {current.error}</Caption> : null}
      {!answer && !unitMissing && (manifest || members.length > 0) && !(current && 'error' in current) ? <Caption icon="hourglass">Checking the selection…</Caption> : null}

      {claims.length > 0 ? (
        <div className="store-decision" role="group" aria-label={`${plural(flagged.size, 'item')} of ${total} need a decision`}>
          <Caption icon="alert-triangle" tone="warn">{plural(flagged.size, 'item')} of {total} {flagged.size === 1 ? 'needs' : 'need'} a decision</Caption>
          {claims.map(({ claim, count, asOf }) => (
            <Caption key={claim} icon="info">
              <Tip content={CLAIMS[claim].consequence}>{count} {count === 1 ? CLAIMS[claim].one : CLAIMS[claim].many}</Tip>
              {' · '}
              <span className="quiet">{asOf.every((at) => at === null) ? 'never read' : `as of ${asOf.filter((at): at is string => at !== null).map((at) => formatRelative(at)).join(', ')}`}</span>
            </Caption>
          ))}
          <Button size="sm" variant="primary" icon="archive" disabled={blocked || leaveCount === 0 || leaveRoom.length > 0} loading={sending === 'leave'} onClick={() => void send(false)}>
            Leave them out and store {plural(leaveCount, 'item')}
          </Button>
          <Button size="sm" icon="archive" disabled={blocked || anywayRoom.length > 0} loading={sending === 'anyway'} onClick={() => void send(true)}>
            Store all {plural(total, 'item')} anyway
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="primary" icon="archive" disabled={blocked || total === 0 || anywayRoom.length > 0} loading={sending === 'leave'} onClick={() => void send(false)}>
          Store {plural(total, 'item')}
        </Button>
      )}
    </>
  );
}
