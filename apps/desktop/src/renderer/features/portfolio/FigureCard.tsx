import React from 'react';
import { Icon, type IconName } from '../../components/Icon.js';
import { Tip } from '../../components/Tip.js';
import { Skeleton } from '../../components/ui.js';
import { MoneyFigures, type Shown } from './money-figures.js';

/** A line under a card's figure: what it counts, and the figure, with a tip on the label when it needs one. */
export type CardLine = { label: React.ReactNode; value: string | Shown; tip?: string | undefined; key?: string | undefined };

/**
 * A portfolio card: a title with its explanation in a tip, the figure, what sits quietly under it
 * (the natives behind a converted figure), and a few lines. `value: null` is a figure not known
 * yet, drawn as a skeleton rather than a zero.
 *
 * `.metric-value` holds the figure and nothing else, so a reader, and a test, reading it gets the
 * amount and its code alone.
 */
export function FigureCard({ title, icon, tip, testId, hue, value, lines = [], index = 0, children }: {
  title: React.ReactNode;
  icon: IconName;
  tip?: React.ReactNode | undefined;
  testId: string;
  /** The holdings hue for the card's top edge, when the card counts one of the venues' buckets. */
  hue?: 'wallet' | 'listed' | 'unconfirmed' | 'inventory' | undefined;
  value: string | Shown | null;
  lines?: readonly CardLine[] | undefined;
  index?: number | undefined;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <article
      className="metric value-card enter"
      data-testid={testId}
      data-hue={hue}
      style={{ animationDelay: `${60 + index * 40}ms` }}
    >
      <div className="metric-head">
        <span className="metric-icon"><Icon name={icon} size={15} /></span>
        <div className="metric-label">{title}</div>
        {tip ? <Tip content={tip} label={typeof title === 'string' ? `About ${title.toLowerCase()}` : undefined} /> : null}
      </div>
      {value === null ? (
        <div className="value-skeleton" aria-hidden="true"><Skeleton width={140} height={24} /></div>
      ) : (
        <div className="metric-value num" data-count={typeof value === 'string' ? 1 : value.figures.length}>
          {typeof value === 'string' ? value : <MoneyFigures figures={value.figures} />}
        </div>
      )}
      {value !== null && typeof value !== 'string' ? <Beside value={value} /> : null}
      {children}
      {lines.length > 0 ? (
        <dl className="value-lines">
          {lines.map((line, at) => (
            <div key={line.key ?? (typeof line.label === 'string' ? line.label : at)}>
              <dt>{line.tip ? <Tip content={line.tip}>{line.label}</Tip> : line.label}</dt>
              <dd className="num">{typeof line.value === 'string' ? line.value : <MoneyFigures figures={line.value.figures} inline />}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </article>
  );
}

/** The natives behind a converted figure, and what had no rate, with each conversion in the tip. */
export function Beside({ value }: { value: Shown }): React.JSX.Element | null {
  const missing = value.missing ?? [];
  if (!value.beside && missing.length === 0) return null;
  const text = (
    <>
      {value.beside}
      {missing.length > 0 ? <span data-tone="warn">{value.beside ? ' · ' : ''}no rate for {missing.join(', ')}, left out</span> : null}
    </>
  );
  const notes = value.notes ?? [];
  return (
    <div className="value-natives num">
      {notes.length > 0 ? <Tip wide content={<>{notes.map((note) => <span key={note} className="tip-line">{note}</span>)}</>}>{text}</Tip> : text}
    </div>
  );
}
