import { convert, type FxRates } from '@cslytics/market-data';
import { buyerCentsOf, venueCurrency, type StagedEntry, type StagedRow, type Venue } from '../../components/listing-workspace-store.js';
import { currencyCodeOf, formatAmount, formatConverted } from '../../lib/money.js';

/**
 * The listing workspaces' rows, as the Items page marks them on the float curve.
 *
 * A row staged for sale or for a new price is a listing being decided, and the curve is where a
 * price is decided against: so every staged unit of the page's name is drawn at its float and the
 * price typed for it, the picture and the figure in its tip, and a price typed into the panel
 * moves its mark in the same render. Two steps, both pure: the shell turns both workspaces' rows
 * into units once (`stagedUnits`), and the curve panel places the units of its own name on its
 * document's axis (`stagedMarks`), which it alone knows the currency of.
 */

/** One staged row the curve could mark: a shown row with a market name and a float. */
export type StagedUnit = {
  key: string;
  /** The market name whose curve it belongs on. */
  marketHashName: string;
  imageUrl: string | null;
  float: number;
  venue: Venue;
  /** What the buyer would pay at the typed figure, or `null` while the row has no price. */
  buyerCents: number | null;
  /** The currency the typed figure is in, as Steam numbers currencies; `null` until the wallet is known. */
  currency: number | null;
};

/**
 * The units of every row on screen. A handed row is the outbox's until the engine answers and is
 * not drawn; a refused row is back on screen and is. A row with no market name has no curve, and
 * one with no float has nowhere on it to sit.
 */
export function stagedUnits(
  rows: ReadonlyArray<StagedRow<StagedEntry>>,
  accounts: ReadonlyArray<{ id: string; currency?: number | null | undefined }>
): StagedUnit[] {
  const units: StagedUnit[] = [];
  for (const row of rows) {
    if (row.state === 'handed') continue;
    const name = row.entry.marketHashName;
    if (typeof name !== 'string' || name === '' || row.entry.paintWear === null) continue;
    units.push({
      key: row.key,
      marketHashName: name,
      imageUrl: row.entry.imageUrl,
      float: row.entry.paintWear,
      venue: row.venue,
      buyerCents: buyerCentsOf(row.venue, row.price, row.basis),
      currency: venueCurrency(row.venue, accounts.find((account) => account.id === row.entry.accountId)?.currency)
    });
  }
  return units;
}

/** A staged unit placed on one curve document's axes. */
export type StagedMark = {
  key: string;
  /** The market name, which is what the tip is headed with. */
  title: string;
  imageUrl: string | null;
  float: number;
  venue: Venue;
  /**
   * Where it sits on the price axis, in the document's currency units. `null` with a `figure` is
   * a price with no rate to the chart's currency, drawn at its float alone; `null` without one is
   * a row with no price yet, which the chart sets on the fair price at its float.
   */
  price: number | null;
  /** The typed figure in its own currency, as the tip prints it; `null` while the row has no price. */
  figure: string | null;
  /** The converted figure that placed it, marked ≈, when its currency is not the chart's. */
  placed: string | null;
};

/**
 * The marks for one name on a document in `currency`. A figure in the document's currency sits
 * where it was typed; one in another crosses at the newest daily rate and says so, because FX is
 * a display grade marked ≈ and never a price (AGENTS.md rule 9); one with no rate is not placed.
 */
export function stagedMarks(units: readonly StagedUnit[], name: string, currency: string, fx: FxRates | null): StagedMark[] {
  const marks: StagedMark[] = [];
  for (const unit of units) {
    if (unit.marketHashName !== name) continue;
    const base = { key: unit.key, title: unit.marketHashName, imageUrl: unit.imageUrl, float: unit.float, venue: unit.venue };
    if (unit.buyerCents === null) {
      marks.push({ ...base, price: null, figure: null, placed: null });
      continue;
    }
    const figure = formatAmount(unit.buyerCents, unit.currency);
    const code = currencyCodeOf(unit.currency);
    if (code === currency) {
      marks.push({ ...base, price: unit.buyerCents / 100, figure, placed: null });
      continue;
    }
    const converted = code ? convert(unit.buyerCents, code, currency, fx) : null;
    marks.push({ ...base, price: converted === null ? null : converted.cents / 100, figure, placed: converted === null ? null : formatConverted(converted) });
  }
  return marks;
}
