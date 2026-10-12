import React from 'react';
import { steamMarketListingUrl } from '@cslytics/catalogue';
import { Badge, Caption, CopyButton, IconButton } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { InspectorHero, InspectorWear } from '../../components/InspectorParts.js';
import { FactGroup, factsText, type Fact } from '../../components/FactGroup.js';
import { qualityLabel } from '../../lib/format.js';
import { UNRESOLVED_REASON, formatDateTime, formatUsd } from '../../lib/labels.js';
import { sideHeading, type NamedTradeEntry, type NamedTradeItem } from './trade-state.js';

type AccountName = { id: string; name: string };

const IDENTITY_SOURCE: Readonly<Record<string, string>> = {
  holding: 'Matched to the item in your inventory',
  'peer-holding': 'Matched to the item on your other account',
  'csfloat-listing': 'From CSFloat\'s listing of it',
  'market-name': 'From Steam\'s description: no float or pattern was observed',
  none: 'Steam named no item for this line, and no walk matched it to one'
};

/**
 * One item of a trade, beside the trade: what it is and where it is now.
 *
 * Built from the item inspector's own parts, so a skin reads the same here as in Inventory, and
 * deliberately without its actions. A trade is a record: nothing on this page sends, lists, moves
 * or accepts anything, so there is no verb to offer and no selection to offer it to. Where the
 * item is now comes from the holding the line resolved to, and an item no account of yours holds
 * says so rather than showing a location it does not have.
 */
export function TradeItemInspector({ item, entry, accounts, multiAccount, onClose }: {
  item: NamedTradeItem;
  entry: NamedTradeEntry;
  accounts: readonly AccountName[];
  multiAccount: boolean;
  /** Puts the item down, and with it the column: the page shows the inspector only for an item. */
  onClose: () => void;
}): React.JSX.Element {
  const nameOf = (id: string): string => accounts.find((account) => account.id === id)?.name ?? id;
  const where = whereNow(item, entry, nameOf);
  const protectedUntil = item.tradeProtectedUntil && Date.parse(item.tradeProtectedUntil) > Date.now() ? item.tradeProtectedUntil : null;

  const facts: Fact[] = [];
  if (item.hashName ?? item.marketHashName) facts.push({ label: 'Market name', value: (item.hashName ?? item.marketHashName)! });
  if (item.paintWear !== null) facts.push({ label: 'Float', value: String(item.paintWear), mono: true });
  if (item.paintSeed !== null) facts.push({ label: 'Pattern', value: String(item.paintSeed), mono: true });
  if (item.quantity > 1) facts.push({ label: 'Quantity', value: item.quantity.toLocaleString(), copy: false });
  const trade: Fact[] = [
    { label: 'Asset ID in the trade', value: item.assetId, mono: true },
    ...(item.newAssetId ? [{ label: 'Asset ID after it', value: item.newAssetId, mono: true }] : []),
    { label: 'Class / instance', value: `${item.classId} / ${item.instanceId}`, mono: true },
    ...(item.csfloatTradeId ? [{ label: 'CSFloat trade', value: item.csfloatTradeId, mono: true }] : []),
    ...(item.csfloatPriceCents !== null ? [{ label: 'CSFloat price', value: `${formatUsd(item.csfloatPriceCents)} USD`, copy: false }] : [])
  ];
  const game: Fact[] = [];
  if (item.defIndex !== null) game.push({ label: 'Def index', value: String(item.defIndex), mono: true });
  if (item.paintIndex !== null) game.push({ label: 'Paint index', value: String(item.paintIndex), mono: true });
  if (item.quality !== null) {
    const quality = qualityLabel(item.quality);
    game.push({ label: 'Quality', value: quality ? `${quality} (${item.quality})` : String(item.quality), mono: quality === null });
  }
  game.push({ label: 'Identity key', value: item.matchKey || '—', mono: true });
  const market = item.hashName ?? item.marketHashName;
  const links: Fact[] = market ? [{ label: 'Steam Market', value: steamMarketListingUrl(market), clip: true }] : [];

  return <aside className="inspector" aria-label="Trade item inspector">
    <div className="inspector-close"><IconButton icon="x" size="sm" label="Close the item" onClick={onClose} /></div>
    <InspectorHero name={item.name} imageUrl={item.imageUrl} rarity={item.rarity} collection={item.collection} account={multiAccount ? nameOf(entry.accountId) : undefined} />
    <div className="toolbar">
      <Badge tone="quiet" icon={item.side === 'GIVE' ? 'arrow-up-right' : 'arrow-down-left'}>{sideHeading(item.side, entry)}</Badge>
      {item.quantity > 1 ? <Badge tone="quiet" icon="layers">× {item.quantity.toLocaleString()}</Badge> : null}
      {item.missing === 1 ? <Badge tone="warn" icon="alert-circle">No longer with the giver</Badge> : null}
    </div>
    <Caption icon="info">{IDENTITY_SOURCE[item.identitySource] ?? item.identitySource}</Caption>
    {item.unresolved && item.unresolved !== 'no-identity' ? <Caption icon="info">{UNRESOLVED_REASON[item.unresolved] ?? item.unresolved}</Caption> : null}
    {item.csfloatPriceCents !== null ? (
      <Caption icon="shopping-cart" tone="accent">
        {item.side === 'RECEIVE' ? 'Bought' : 'Sold'} on CSFloat for {formatUsd(item.csfloatPriceCents)} USD
      </Caption>
    ) : null}
    <InspectorWear paintWear={item.paintWear} paintSeed={item.paintSeed} range={item} />
    <div className="inspector-where" data-testid="trade-item-where">
      <span className="inline"><Icon name={where.icon} size={13} /> {where.text}</span>
      {protectedUntil ? <span className="inline"><Icon name="lock" size={13} /> Trade-protected until {formatDateTime(protectedUntil)}</span> : null}
      {item.tradableAfter && Date.parse(item.tradableAfter) > Date.now() ? <span className="inline"><Icon name="clock" size={13} /> Tradable after {formatDateTime(item.tradableAfter)}</span> : null}
    </div>
    <details className="technical item-facts">
      <summary><Icon name="chevron-right" size={13} /> Show more details</summary>
      <div className="item-facts-body">
        <div className="item-facts-tools"><CopyButton value={factsText([...facts, ...trade, ...game, ...links])} label="Copy all details" /></div>
        <FactGroup title="Item" facts={facts} />
        <FactGroup title="In this trade" facts={trade} />
        <FactGroup title="Game data" facts={game} />
        <FactGroup title="Links" facts={links} />
      </div>
    </details>
  </aside>;
}

function whereNow(item: NamedTradeItem, entry: NamedTradeEntry, nameOf: (id: string) => string): { text: string; icon: 'package' | 'archive' | 'tag' | 'arrow-left-right' | 'info' } {
  if (!item.localId || !item.holderAccountId) {
    if (item.side === 'RECEIVE' && entry.tradeStatus !== 'COMPLETE') return { text: 'Not yours yet: it is still with the other party', icon: 'info' };
    return { text: 'Not matched to an item any of your accounts holds', icon: 'info' };
  }
  const holder = nameOf(item.holderAccountId);
  switch (item.location) {
    case 'MAIN': return { text: `In ${holder}'s inventory`, icon: 'package' };
    case 'CASKET': return { text: `In a storage unit on ${holder}`, icon: 'archive' };
    default:
      if (item.endReason === 'traded') return { text: `No longer held by ${holder}: traded away`, icon: 'arrow-left-right' };
      if (item.endReason === 'sold') return { text: `No longer held by ${holder}: sold`, icon: 'tag' };
      return { text: `No longer held by ${holder}`, icon: 'info' };
  }
}
