import React, { useState } from 'react';
import type { StoragePageRow } from '@cslytics/engine';
import { Caption, IconButton, ProgressBar } from '../../components/ui.js';
import { engine } from '../../lib/engine.js';
import { UNIT_CAPACITY, describeRename, unitFill, unitName } from './storage-unit.js';

/**
 * The parts of an inspector that belong to a storage unit shown as an item: its name, which can be
 * changed, and how full it is.
 */

type Status = ReturnType<typeof describeRename>;

/**
 * A storage unit's name with a pencil beside it, which turns the name into a field.
 *
 * The name shown is always the observed label (rule 1): what was asked for is reported under the
 * name until an observation carries it, never in its place. One rename is one instruction (OP-01),
 * so the field and its tick are the whole of it — there is no preview. `onSettled` is the owner's
 * cue to re-read the unit, which is how the new label reaches the name.
 */
export function UnitName({ unit, onSettled }: { unit: StoragePageRow; onSettled: () => void }): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const shown = unitName(unit);
  const requested = name.trim();
  const unchanged = requested.length === 0 || requested === unit.label;

  function edit(): void {
    setName(unit.label ?? '');
    setStatus(null);
    setEditing(true);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || unchanged) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await engine.renameStorageUnit(unit.accountId, unit.casketId, requested);
      setStatus(describeRename(result, requested));
      // A refusal keeps the field open so the name can be fixed; anything else has been sent, and
      // the caption says whether Steam shows it yet.
      if (result.outcome !== 'DEFINITIVELY_REJECTED') setEditing(false);
      onSettled();
    } catch (reason) {
      // The engine's own words: a name it will not send says exactly what is wrong with it.
      // Electron prefixes a rejection from main, and the engine's sentence is what follows it.
      const message = reason instanceof Error ? reason.message : String(reason);
      setStatus({ tone: 'warn', text: message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i, '').trim() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="unit-name">
      {editing ? (
        <form
          className="unit-name-row"
          aria-label={`Rename ${shown}`}
          onSubmit={(event) => void submit(event)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || busy) return;
            event.stopPropagation();
            setEditing(false);
          }}
        >
          <input
            className="input input-sm"
            value={name}
            maxLength={20}
            disabled={busy}
            aria-label="New name"
            placeholder="New name"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          <IconButton icon="check" size="sm" variant="subtle" type="submit" label="Save name" disabled={busy || unchanged} />
          <IconButton icon="x" size="sm" label="Cancel rename" disabled={busy} onClick={() => setEditing(false)} />
        </form>
      ) : (
        <div className="unit-name-row">
          <span className="inspector-name">{shown}</span>
          <IconButton icon="pencil" size="sm" label={`Rename ${shown}`} onClick={edit} />
        </div>
      )}
      {busy ? <Caption icon="hourglass">Asking Steam to rename it…</Caption> : null}
      {!busy && status ? (
        <Caption icon={status.tone === 'positive' ? 'check' : status.tone === 'warn' ? 'alert-circle' : 'hourglass'} tone={status.tone === 'quiet' ? undefined : status.tone}>
          {status.text}
        </Caption>
      ) : null}
    </div>
  );
}

/** How full the unit is, by the count it reports, against the thousand the Game Coordinator allows. */
export function UnitFill({ unit }: { unit: StoragePageRow }): React.JSX.Element {
  const { used, free, full } = unitFill(unit.reportedCount);
  return (
    <div className="unit-fill">
      <ProgressBar value={used} max={UNIT_CAPACITY} tone={full ? 'warn' : 'accent'} label={`${used} of ${UNIT_CAPACITY} slots used`} />
      <Caption icon="archive" tone={full ? 'warn' : undefined}>
        <span><span className="num">{used.toLocaleString()}</span> of {UNIT_CAPACITY.toLocaleString()} slots used · {full ? 'full' : `${free.toLocaleString()} free`}</span>
      </Caption>
    </div>
  );
}
