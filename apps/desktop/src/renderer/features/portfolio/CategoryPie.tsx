import React, { useState } from 'react';
import { formatAmount } from '../../lib/money.js';
import { plural } from '../../lib/labels.js';
import { arcPath, type PieSlice } from './pie-math.js';

/**
 * The inventory's value by category: a ring, drawn in SVG with no library, and the legend that
 * reads it. The legend is the chart's accessible form, so every slice is a row there with its
 * figure, its units and its share; the ring itself is decoration for the eye, named once as an
 * image. Pointing at a slice or its row lights both and puts the slice's share in the centre;
 * otherwise the centre holds the priced total.
 */

const SIZE = 184;
const OUTER = 86;
const INNER = 56;

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
}

export function CategoryPie({ slices, base, totalCents, testId }: {
  slices: readonly PieSlice[];
  /** ISO code every slice is in. */
  base: string;
  /** The priced total the slices share, for the centre. */
  totalCents: number;
  testId?: string | undefined;
}): React.JSX.Element {
  const [active, setActive] = useState<string | null>(null);
  const lit = active === null ? null : slices.find((slice) => slice.key === active) ?? null;
  const centre = SIZE / 2;
  const pct = (slice: PieSlice): string => `${slice.share < 0.005 && slice.share > 0 ? '<1' : Math.round(slice.share * 100)}%`;
  const spoken = slices.map((slice) => `${slice.label} ${pct(slice)}`).join(', ');

  return (
    <div className="category-pie" data-testid={testId} data-active={active ?? undefined}>
      <svg
        className="category-ring"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label={`Inventory value by category: ${spoken}`}
        onPointerLeave={() => setActive(null)}
      >
        {slices.map((slice) => (
          <path
            key={slice.key}
            className="category-slice"
            d={arcPath(centre, centre, OUTER, INNER, slice.start, slice.end)}
            style={{ fill: `var(${slice.variable})` }}
            data-dim={active !== null && active !== slice.key ? true : undefined}
            onPointerEnter={() => setActive(slice.key)}
          >
            <title>{`${slice.label}: ≈ ${formatAmount(slice.cents, base)} · ${pct(slice)}`}</title>
          </path>
        ))}
        <text className="category-centre-value num" x={centre} y={centre - 3} textAnchor="middle" dominantBaseline="auto">
          {lit ? pct(lit) : `≈ ${formatAmount(totalCents, base)}`}
        </text>
        <text className="category-centre-label" x={centre} y={centre + 14} textAnchor="middle">
          {lit ? lit.label : plural(slices.length, 'category', 'categories')}
        </text>
      </svg>
      <ul className="category-legend" aria-label="Value by category">
        {slices.map((slice) => (
          <li
            key={slice.key}
            className="category-row"
            data-testid={`portfolio-category-${slug(slice.key)}`}
            data-complete={slice.complete}
            data-dim={active !== null && active !== slice.key ? true : undefined}
            title={slice.members.length > 0 ? slice.members.join(', ') : undefined}
            onPointerEnter={() => setActive(slice.key)}
            onPointerLeave={() => setActive(null)}
          >
            <span className="allocation-dot" aria-hidden="true" style={{ background: `var(${slice.variable})` }} />
            <span className="category-name">{slice.label}</span>
            <span className="num">≈ {formatAmount(slice.cents, base)}{slice.complete ? '' : ' · partly unconverted'}</span>
            <span className="cell-sub">{plural(slice.units, 'unit')} · {pct(slice)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
