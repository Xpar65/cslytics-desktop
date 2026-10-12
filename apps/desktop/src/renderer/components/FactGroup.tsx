import React from 'react';
import { CopyButton } from './ui.js';

/**
 * One line of a facts fold: what someone pastes somewhere else, each with its own copy button.
 *
 * `copy: false` is for a yes or no, which nobody pastes anywhere. `clip` is for a value too long to
 * show whole, such as a URL; the full value is its title and what the button copies.
 */
export type Fact = { label: string; value: string; mono?: boolean; copy?: boolean; clip?: boolean };

/**
 * A titled group of facts, laid out as label, value and copy in a row where there is room and the
 * label over the value where there is not. Nothing at all when it has neither facts nor children.
 */
export function FactGroup({ title, facts, children }: { title: string; facts: readonly Fact[]; children?: React.ReactNode }): React.JSX.Element | null {
  if (facts.length === 0 && !children) return null;
  return (
    <section className="item-facts-group" aria-label={title}>
      <h4>{title}</h4>
      <dl>
        {facts.map((fact) => (
          <div className="fact" key={fact.label} data-clip={fact.clip || undefined}>
            <dt>{fact.label}</dt>
            <dd>
              <span className={fact.mono ? 'fact-value fact-mono' : 'fact-value'} title={fact.clip ? fact.value : undefined}>{fact.value}</span>
              {fact.copy === false ? null : <CopyButton value={fact.value} label={`Copy ${fact.label.toLowerCase()}`} />}
            </dd>
          </div>
        ))}
        {children}
      </dl>
    </section>
  );
}

/** Every fact of a fold as `Label: value` lines, for one "Copy all" button. */
export function factsText(facts: readonly Fact[]): string {
  return facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n');
}
