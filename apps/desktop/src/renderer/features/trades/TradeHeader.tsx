import React from 'react';
import { CopyButton } from '../../components/ui.js';
import { Avatar } from '../../components/Avatar.js';
import { Icon } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import { FactGroup, factsText, type Fact } from '../../components/FactGroup.js';
import { TRADE_STATUS, formatDateTime, formatUsd, humanize, stateLabel } from '../../lib/labels.js';
import { describeOrigin, describeTradeState, hadReversalPeriod, profileUrl, stageBadge, type NamedTradeEntry } from './trade-state.js';
import { StageBadge, StageIcon } from './StageIcon.js';

type AccountName = { id: string; name: string; avatarRef?: string | null | undefined };

const EVIDENCE: Readonly<Record<string, string>> = {
  'offer-id': 'CSFloat\'s own record names this Steam offer',
  'own-delivery': 'CSlytics sent this offer to deliver the CSFloat sale',
  asset: 'The item CSFloat sold moved in this trade, with the party CSFloat names on the other side'
};

/**
 * The selected trade: what it was for, where it stands in one sentence, and everything behind
 * both folded under Details.
 *
 * The origin leads because it is the question a person opens a trade to answer — "is this the
 * Redline I bought?" — and the sentence under it is the trade's state in words rather than codes.
 * Details holds the identifiers, the evidence for the origin, the walks it all rests on and the
 * status journal, each fact copyable, for the times the words are not enough.
 */
export function TradeHeader({ entry, accounts, multiAccount }: {
  entry: NamedTradeEntry;
  accounts: readonly AccountName[];
  multiAccount: boolean;
}): React.JSX.Element {
  const nameOf = (id: string): string => accounts.find((account) => account.id === id)?.name ?? id;
  const account = nameOf(entry.accountId);
  const peer = entry.peerAccountId ? nameOf(entry.peerAccountId) : null;
  const state = describeTradeState(entry, peer ?? 'the other party');
  const itemName = entry.csfloat.length === 1 ? entry.csfloat[0]!.name : entry.identitySource === null ? null : entry.name;
  const origin = describeOrigin(entry, { account, peer, itemName });
  const status = stageBadge(entry);

  return (
    <section className="trade-header" aria-label="Trade">
      <div className="trade-header-top">
        <span className="trade-origin-mark" aria-hidden="true">
          {origin.venue ? <VenueMark venue="csfloat" size={22} decorative /> : <Icon name={origin.icon} size={18} />}
        </span>
        <div className="trade-header-titles">
          <div className="trade-header-title" data-testid="trade-origin">{origin.title}</div>
          {origin.detail ? <div className="trade-header-origin">{origin.detail}</div> : null}
        </div>
        <span className="trade-header-badges">
          {multiAccount ? <span className="inline"><Avatar name={account} size={16} photo={accounts.find((row) => row.id === entry.accountId)?.avatarRef} />{account}</span> : null}
          <StageBadge label={status.label} tone={status.tone} icon={status.icon} title={status.hint} />
        </span>
      </div>
      <div className="trade-state" data-tone={state.tone} role="status">
        <StageIcon name={state.icon} size={state.icon === 'trade-protected' ? 22 : 15} />
        <div>
          <div className="trade-state-headline" data-testid="trade-state">{state.headline}</div>
          {state.detail ? <div className="caption">{state.detail}</div> : null}
        </div>
      </div>
      <TradeDetails entry={entry} account={account} peer={peer} />
    </section>
  );
}

function TradeDetails({ entry, account, peer }: { entry: NamedTradeEntry; account: string; peer: string | null }): React.JSX.Element {
  const steam: Fact[] = [];
  if (entry.offerId) steam.push({ label: 'Offer number', value: entry.offerId, mono: true });
  if (entry.tradeId) steam.push({ label: 'Trade id', value: entry.tradeId, mono: true });
  if (entry.direction) steam.push({ label: 'Direction', value: entry.direction === 'SENT' ? `Sent by ${account}` : `Received by ${account}`, copy: false });
  steam.push({ label: 'Created', value: formatDateTime(entry.createdAt), copy: false });
  if (entry.acceptedAt) steam.push({ label: 'Accepted', value: formatDateTime(entry.acceptedAt), copy: false });
  if (entry.settlesAt) {
    // Only a trade settled after it was accepted had a reversal period to end.
    const label = !hadReversalPeriod(entry) ? 'Settled' : entry.stage === 'reversal-period' ? 'Reversal period ends' : 'Reversal period ended';
    steam.push({ label, value: formatDateTime(entry.settlesAt), copy: false });
  }
  if (entry.offerUpdatedAt) steam.push({ label: 'Offer last changed', value: formatDateTime(entry.offerUpdatedAt), copy: false });
  if (entry.expiresAt) steam.push({ label: 'Expires', value: formatDateTime(entry.expiresAt), copy: false });
  if (entry.escrowUntil) steam.push({ label: 'Held until', value: formatDateTime(entry.escrowUntil), copy: false });
  if (entry.initiatedAt) steam.push({ label: 'Trade started', value: formatDateTime(entry.initiatedAt), copy: false });
  if (entry.offerStatus) steam.push({ label: 'Offer state', value: `${stateLabel(TRADE_STATUS, entry.offerStatus).label} (code ${entry.rawOfferState ?? '?'})`, copy: false });
  if (entry.tradeStatus) steam.push({ label: 'Trade status', value: `${stateLabel(TRADE_STATUS, entry.tradeStatus).label} (code ${entry.rawTradeStatus ?? '?'})`, copy: false });
  if (entry.message) steam.push({ label: 'Message', value: entry.message });

  const party: Fact[] = [];
  if (peer) party.push({ label: 'Your account', value: peer, copy: false });
  if (entry.counterpartySteamId64) {
    party.push({ label: 'Steam ID', value: entry.counterpartySteamId64, mono: true });
    party.push({ label: 'Profile', value: profileUrl(entry.counterpartySteamId64), clip: true });
  }

  const origin: Fact[] = [];
  if (entry.transfer) {
    origin.push({ label: 'Transfer command', value: entry.transfer.commandId, mono: true });
    origin.push({ label: 'Transfer state', value: humanize(entry.transfer.state), copy: false });
    if (entry.transfer.reason) origin.push({ label: 'Transfer note', value: entry.transfer.reason, copy: false });
    origin.push({ label: 'Evidence', value: entry.transfer.evidence === 'offer-id' ? 'The transfer names this offer' : 'The offer carries the transfer\'s message; not yet matched by number', copy: false });
  }
  entry.csfloat.forEach((link, index) => {
    const n = entry.csfloat.length > 1 ? ` ${index + 1}` : '';
    origin.push({ label: `CSFloat trade${n}`, value: link.tradeId, mono: true });
    origin.push({ label: `CSFloat item${n}`, value: link.hashName ?? link.name, copy: false });
    if (link.priceCents !== null) origin.push({ label: `CSFloat price${n}`, value: `${formatUsd(link.priceCents)} USD`, copy: false });
    if (link.floatValue !== null) origin.push({ label: `CSFloat float${n}`, value: String(link.floatValue), mono: true });
    origin.push({ label: `CSFloat state${n}`, value: humanize(link.state), copy: false });
    origin.push({ label: `CSFloat listing${n}`, value: link.listingId, mono: true });
    origin.push({ label: `Evidence${n}`, value: EVIDENCE[link.evidence] ?? link.evidence, copy: false });
  });

  const observed: Fact[] = entry.coverage.map((row) => ({
    label: SURFACE_NAME[row.surface] ?? humanize(row.surface),
    value: row.observedAt
      ? `${formatDateTime(row.observedAt)}${row.complete === 1 ? '' : ` · did not finish${row.error ? ` (${row.error})` : ''}`}`
      : 'Never read',
    copy: false
  }));
  if (entry.firstSeenAt) observed.push({ label: 'First seen', value: formatDateTime(entry.firstSeenAt), copy: false });
  if (entry.lastSeenAt) observed.push({ label: 'Last seen', value: formatDateTime(entry.lastSeenAt), copy: false });

  const all = [...steam, ...party, ...origin, ...observed];
  return (
    <details className="technical item-facts trade-details">
      <summary><Icon name="chevron-right" size={13} /> Details</summary>
      <div className="item-facts-body">
        <div className="item-facts-tools"><CopyButton value={factsText(all)} label="Copy all details" /></div>
        <FactGroup title="Steam" facts={steam} />
        <FactGroup title="Other party" facts={party} />
        <FactGroup title="What it was for" facts={origin} />
        <FactGroup title="Observed" facts={observed} />
        {entry.timeline.length > 0 ? (
          <section className="item-facts-group" aria-label="Status history">
            <h4>Status history</h4>
            <ol className="trade-timeline">
              {entry.timeline.map((event, index) => (
                <li key={`${event.source}:${event.at}:${event.raw}:${index}`}>
                  <span className="num">{formatDateTime(event.at)}</span>
                  <span>{event.source === 'offer' ? 'Offer' : 'Trade'} {stateLabel(TRADE_STATUS, event.status).label.toLowerCase()}</span>
                  <span className="quiet mono">code {event.raw}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </details>
  );
}

/** The three walks a trade rests on, by the name a person would look for. */
const SURFACE_NAME: Readonly<Record<string, string>> = {
  'steam-trade-offers': 'Steam trade offers',
  'steam-trade-history': 'Steam trade history',
  'csfloat-trades': 'CSFloat trades'
};
