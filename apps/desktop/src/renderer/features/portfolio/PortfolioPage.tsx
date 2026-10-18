import React from 'react';
import type { AccountHoldings } from '../../lib/types.js';
import { HoldingsPanel } from './HoldingsPanel.js';
import { AccountsTable, PortfolioView } from './PortfolioView.js';
import { ValuePanel } from './ValuePanel.js';
import { useValuation } from './use-valuation.js';

/**
 * The portfolio page, top to bottom: the total holdings and their bar; the wallets, each venue's
 * apart, and the money on the market; what the inventory is worth; the accounts. Every panel reads
 * the one valuation, so main assembles it once per change rather than once per panel.
 */
export function PortfolioPage({
  accountIds,
  holdings,
  scope,
  avatars,
  onSelectAccount
}: {
  accountIds: readonly string[];
  holdings: readonly AccountHoldings[];
  scope: string | null;
  avatars?: Readonly<Record<string, string | null>> | undefined;
  onSelectAccount: (accountId: string) => void;
}): React.JSX.Element {
  const state = useValuation(accountIds);
  return (
    <div className="portfolio-page">
      <HoldingsPanel holdings={holdings} scope={scope} state={state} />
      <PortfolioView holdings={holdings} valuation={state.valuation} />
      <ValuePanel state={state} holdings={holdings} />
      {scope === null ? <AccountsTable holdings={holdings} valuation={state.valuation} avatars={avatars} onSelectAccount={onSelectAccount} /> : null}
    </div>
  );
}
