import React from 'react';
import type { QuantityView } from '../../lib/portfolio.js';
import { currencyCodeOf, formatAmount, type CurrencyRef } from '../../lib/money.js';

/** One observed figure, formatted, with the code it is in. */
export type Figure = { code: string; text: string };

/** How one quantity is printed: its figures, what sits quietly under them, and the hover that says where they came from. */
export type Shown = { figures: Figure[]; beside?: string | undefined; missing?: string[] | undefined; notes?: string[] | undefined };

/**
 * One or several observed figures. Several are the mixed-currency scope with no rate to convert
 * at, and each keeps its own code, never joined into one string that reads as a single amount.
 * Stacked in a card, where headline type would overflow one line; `inline`, with a separator, in
 * the headline and the legend.
 */
export function MoneyFigures({ figures, inline = false }: { figures: readonly Figure[]; inline?: boolean }): React.JSX.Element {
  return (
    <span className="money-figures num" data-count={figures.length} data-inline={inline || undefined}>
      {figures.map((figure, index) => (
        <span key={`${figure.code}:${index}`} className="money-figure" data-currency={figure.code || undefined}>{figure.text}</span>
      ))}
    </span>
  );
}

/**
 * A quantity as a card prints it. A scope that holds none of it prints zero in `home`, the
 * currency the quantity is in when there is only one: an empty wallet is "A$0.00 AUD", not blank.
 * With no home either, nothing is known, and it says so with a dash.
 */
export function shown(view: QuantityView, home: CurrencyRef): Shown {
  if (view.main.length === 0) {
    const code = currencyCodeOf(home);
    return { figures: [{ code, text: code === '' ? '—' : formatAmount(0, home) }] };
  }
  return {
    figures: view.main.map((amount) => ({ code: currencyCodeOf(amount.currency), text: `${amount.approx ? '≈ ' : ''}${formatAmount(amount.cents, amount.currency)}` })),
    beside: view.beside.length > 0 ? view.beside.map((amount) => `${amount.approx ? '≈ ' : ''}${formatAmount(amount.cents, amount.currency)}`).join(' + ') : undefined,
    missing: view.missing,
    notes: view.notes
  };
}
