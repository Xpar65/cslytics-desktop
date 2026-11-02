import React, { useEffect, useState } from 'react';
import { priceAtFloat } from '@cslytics/market-data';
import type { ItemCurve } from '../../shared/market.js';
import { engine } from '../lib/engine.js';
import { formatAmount } from '../lib/money.js';
import { Icon } from './Icon.js';
import { Tip } from './Tip.js';
import { VenueMark } from './VenueMark.js';

/**
 * One item's float price on CSFloat, read off CSlytics's CSFloat float curve at its own float: what
 * it is worth where a float is priced item by item, beside the Steam book's bid, mid and ask. The
 * curve is in US dollars and the figure is an estimate, marked `≈`; nothing here is ever sent as a
 * price (AGENTS.md rule 9). Main keeps the curve a day, so moving between items costs nothing twice.
 *
 * The caller shows this only while the grant holds `curves.csfloat`, so main is never sent a read
 * it would refuse.
 */
export function FloatPriceLine({ name, float }: { name: string; float: number }): React.JSX.Element {
  const [curve, setCurve] = useState<ItemCurve | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setCurve(undefined);
    engine.itemCurve(name, 'csfloat')
      .then((answer) => { if (live) setCurve(answer); })
      .catch(() => { if (live) setCurve(null); });
    return () => { live = false; };
  }, [name]);

  if (curve === undefined) {
    return (
      <span className="float-price quiet" data-testid="inspector-float-price" data-state="waiting" title="Reading the CSFloat float curve">
        <Icon name="loader" size={12} className="spin" />
      </span>
    );
  }
  const doc = curve?.doc ?? null;
  const price = doc === null ? null : priceAtFloat(doc.fairPrice?.vertices, float);
  if (doc === null || price === null) {
    return (
      <Tip content="CSlytics publishes no CSFloat float curve for this item.">
        <span className="float-price quiet" data-testid="inspector-float-price" data-state="none">
          <VenueMark venue="csfloat" size={11} decorative />no CSFloat curve
        </span>
      </Tip>
    );
  }
  const cents = Math.round(price * 100);
  return (
    <Tip content={`CSlytics's CSFloat float curve at this item's float, ${float.toFixed(4)}: what it is worth on CSFloat, in ${doc.currency}. An estimate, never a price that is sent.`}>
      <span className="float-price" data-testid="inspector-float-price" data-state="priced" data-cents={cents} data-currency={doc.currency} data-float={float}>
        <VenueMark venue="csfloat" size={11} decorative />
        <span className="num">≈ {formatAmount(cents, doc.currency)}</span>
        <span className="quiet">at {float.toFixed(4)}</span>
      </span>
    </Tip>
  );
}
