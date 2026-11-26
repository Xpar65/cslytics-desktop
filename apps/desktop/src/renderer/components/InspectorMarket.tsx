import React, { useMemo } from 'react';
import { Button } from './ui.js';
import { OrderBookLine } from './OrderBookLine.js';
import { FloatPriceLine } from './FloatPriceLine.js';
import { SignInLock } from './SignInLock.js';
import { bookKey, useOrderBooks } from '../lib/order-books.js';
import { useCslytics } from '../lib/cslytics.js';
import { FEATURE_CSFLOAT_CURVES, FEATURE_STEAM_MARKET, lockReason } from '../../shared/command-access.js';

/**
 * The market one item is priced against, in an inspector: Steam's book for its market name, its
 * float price on CSFloat's curve when it has a float, and the way to its Items page.
 *
 * Shared by the item inspector and the listing inspector, because a listing is the same item seen
 * from the market's side and the two should read the same. The book is read live while it is on
 * screen — one `item.watch` with the account, so a wallet the anonymous book is not priced for sees
 * its own (plan D17) — and for no other item. To read, not to press: a price is typed in the listing
 * workspace, from the book on its row.
 *
 * Behind the CSlytics sign-in (pricing behind sign-in plan §7.6): while it is locked, or not yet
 * known, no book is asked for, so main is never sent the read it would refuse.
 */
export function InspectorMarket({ accountId, marketHashName, paintWear, onOpenItem }: {
  accountId: string;
  /** The Steam market name. A listing on CSFloat is sold under it too. */
  marketHashName: string;
  paintWear: number | null | undefined;
  /** Opens the Items page for the name. Absent for an item no market sells, which has no page. */
  onOpenItem?: ((name: string) => void) | undefined;
}): React.JSX.Element {
  const cslytics = useCslytics();
  const bookLocked = cslytics === null || lockReason(cslytics, FEATURE_STEAM_MARKET) !== null;
  const curveLocked = cslytics === null || lockReason(cslytics, FEATURE_CSFLOAT_CURVES) !== null;
  const keys = useMemo(() => (bookLocked ? [] : [{ accountId, name: marketHashName }]), [bookLocked, accountId, marketHashName]);
  const books = useOrderBooks(keys, true);
  return (
    <div className="inspector-book" data-testid="inspector-book">
      {!bookLocked ? <OrderBookLine quote={books.get(bookKey(accountId, marketHashName))} /> : cslytics ? (
        <SignInLock
          status={cslytics}
          feature={FEATURE_STEAM_MARKET}
          shape="inline"
          title="Order book"
          tip="The highest buy order, the mid and the lowest listing for this item, read live from Steam."
          testId="inspector-book-lock"
        />
      ) : null}
      {!curveLocked && paintWear !== null && paintWear !== undefined ? <FloatPriceLine name={marketHashName} float={paintWear} /> : null}
      {onOpenItem ? (
        <Button size="sm" variant="ghost" icon="trending-up" data-testid="open-item-page" onClick={() => onOpenItem(marketHashName)}>
          Item page
        </Button>
      ) : null}
    </div>
  );
}
