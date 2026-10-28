import React from 'react';
import { Icon } from './Icon.js';
import { Tip } from './Tip.js';
import { VenueMark } from './VenueMark.js';
import { relativeTime } from '../lib/format.js';
import { LIVE_WITHIN_MS } from '../lib/order-books.js';
import { currencyCodeOf, formatAmount, formatConverted, formatTick } from '../lib/money.js';
import type { ItemBook } from '../../shared/market.js';

/**
 * The Steam order book on one line: highest bid, mid, lowest ask, in the book's currency, with
 * how old the read is. The dot is lit while the read is current; the code names the currency once.
 *
 * Given `onPick`, each figure is a press that prices a row at it, as what the buyer pays — every
 * figure in a book is a buyer's — when the row is priced in the book's currency (`currency`). A
 * row in another currency (a CSFloat row beside an AUD book) still sees the figures; it just
 * cannot take one as typed, because a figure that is sent is never converted (AGENTS.md rule 9).
 * Without `onPick` the figures are there to read, as the item inspector shows them: a price is
 * typed in the listing workspace, from the book on its row.
 */
export function OrderBookLine({ quote, currency = null, onPick }: {
  /** `undefined` while the first read is on its way. */
  quote: ItemBook | undefined;
  /** What the row's typed figure is in. Read only with `onPick`. */
  currency?: number | null;
  onPick?: ((cents: number) => void) | undefined;
}): React.JSX.Element {
  if (quote === undefined) {
    return <span className="listing-book quiet" data-state="waiting" title="Reading the Steam order book"><Icon name="loader" size={12} className="spin" /></span>;
  }
  const { book, status } = quote;
  if (book === null) {
    const absent = status?.kind === 'absent';
    return (
      <Tip content={absent ? 'Steam has no market for this item.' : 'Steam has not answered for this item yet. It is asked again on its own.'}>
        <span className="listing-book quiet" data-state={absent ? 'absent' : 'unknown'}>
          <VenueMark venue="steam" size={11} decorative />{absent ? 'no market' : '—'}
        </span>
      </Tip>
    );
  }
  const mid = book.lowestAskCents !== null && book.highestBidCents !== null ? Math.round((book.lowestAskCents + book.highestBidCents) / 2) : null;
  const same = onPick !== undefined && currency === book.currency;
  const age = Date.now() - Date.parse(book.observedAt);
  const observed = `${quote.own ? "The account's own read of the Steam order book, in its wallet's currency" : 'Steam order book'}, read ${relativeTime(book.observedAt)}`;
  const figure = (label: string, tone: 'bid' | 'ask' | 'mid', cents: number | null, what: string, converted: ItemBook['converted'][keyof ItemBook['converted']]): React.JSX.Element => {
    const amount = cents === null ? '—' : formatTick(cents, book.currency);
    const worth = converted ? ` (${formatConverted(converted)})` : '';
    const title = cents === null
      ? `${what}: none. ${observed}.`
      : onPick === undefined
        ? `${what}: ${formatAmount(cents, book.currency)}${worth}. ${observed}.`
        : same
          ? `${what}: ${formatAmount(cents, book.currency)}${worth}. ${observed}. Press to price this row at it, as what the buyer pays.`
          : `${what}: ${formatAmount(cents, book.currency)}${worth}. ${observed}. This row is priced in ${currencyCodeOf(currency) || 'another currency'}, so it cannot take the figure as typed.`;
    const inner = <><span className="listing-quote-label">{label}</span><span className="num">{amount}</span></>;
    if (onPick === undefined) return <span className="listing-quote" data-tone={tone} title={title}>{inner}</span>;
    return (
      <button type="button" className="listing-quote" data-tone={tone} disabled={cents === null || !same} title={title} onClick={() => { if (cents !== null) onPick(cents); }}>
        {inner}
      </button>
    );
  };
  return (
    <span className="listing-book" data-state="book" data-live={age <= LIVE_WITHIN_MS || undefined} data-testid="listing-book">
      {figure('Bid', 'bid', book.highestBidCents, 'Highest bid, the top buy order', quote.converted.bid)}
      {figure('Mid', 'mid', mid, 'Mid, halfway between the highest bid and the lowest ask', quote.converted.mid)}
      {figure('Ask', 'ask', book.lowestAskCents, 'Lowest ask, the cheapest listing', quote.converted.ask)}
      <span className="listing-book-code" title={observed}><span className="listing-book-dot" aria-hidden="true" />{currencyCodeOf(book.currency)}</span>
    </span>
  );
}
