import React, { useState } from 'react';
import { STEAM_CURRENCY_CODES, currencyByCode } from '@cslytics/market-data';
import { Icon } from '../../components/Icon.js';
import { Caption, Notice, Panel, PanelHeader, Select, Switch } from '../../components/ui.js';
import { chooseBaseCurrency, setAccountPagesInBase, useCurrency } from '../../lib/currency.js';

/**
 * Settings › General › Currency: the base currency and the account-pages toggle (portfolio and
 * pricing plan §5.2), each with an info icon that opens the explanation beside it (§5.3).
 *
 * What a choice here never does: change a price someone types. The listing composer and the
 * buy-order form take the account's own currency whatever this says, and the explanations say so.
 */

const EXPLANATIONS = {
  base: 'The currency your portfolio totals and cross-account figures are shown in. Converted figures are marked ≈ and show the original amount, the rate and its date on hover. This never changes what Steam or CSFloat charge or pay. Default: the wallet currency of the first account you added.',
  pages: "Off: an account's pages show its own currencies. Steam figures are in that account's wallet currency, CSFloat figures are in USD. On: those figures are converted to your base currency as well. Prices you type are always in the account's own currency.",
  conversion: 'Rates come from CSlytics\'s daily snapshot. Steam converts at its own rate, so a converted figure is approximate. If no rate is available for a currency, that figure stays unconverted and is left out of totals, and the total says so.'
} as const;

type Topic = keyof typeof EXPLANATIONS;

export function CurrencyPanel(): React.JSX.Element {
  const { settings, base } = useCurrency();
  const [open, setOpen] = useState<Topic | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(change: () => Promise<void>): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await change();
    } catch (failure) {
      setError(`The currency setting could not be saved: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      setSaving(false);
    }
  }

  const toggle = (topic: Topic): void => setOpen((current) => (current === topic ? null : topic));
  const chosen = currencyByCode(base);

  return (
    <Panel>
      <PanelHeader title="Currency" icon="wallet" />
      <div className="panel-body stack">
        <div className="currency-setting">
          <label className="currency-setting-label" htmlFor="base-currency">Base currency</label>
          <Select label="Base currency" value={base} disabled={saving} onChange={(code) => void save(() => chooseBaseCurrency(code))}>
            {STEAM_CURRENCY_CODES.map((code) => {
              const currency = currencyByCode(code);
              return <option key={code} value={code}>{code}{currency && currency.symbol !== code ? ` · ${currency.symbol}` : ''}</option>;
            })}
          </Select>
          <InfoToggle topic="base" open={open === 'base'} onToggle={toggle} label="About the base currency" />
        </div>
        {open === 'base' ? <Notice tone="info">{EXPLANATIONS.base}</Notice> : null}
        <Caption icon="info" tone="quiet">
          {settings.base === null
            ? 'USD until an account\'s wallet has been observed; then that wallet\'s currency, unless you choose one here.'
            : settings.baseSource === 'first-account'
              ? `${base}${chosen ? ` (${chosen.symbol})` : ''}, from your first account's wallet. Choose another above at any time.`
              : `${base}${chosen ? ` (${chosen.symbol})` : ''}, chosen here.`}
        </Caption>

        <div className="currency-setting">
          <Switch
            checked={settings.showAccountPagesInBase}
            disabled={saving}
            onChange={(on) => void save(() => setAccountPagesInBase(on))}
            label="Show account pages in base currency"
          />
          <InfoToggle topic="pages" open={open === 'pages'} onToggle={toggle} label="About account pages in the base currency" />
        </div>
        {open === 'pages' ? <Notice tone="info">{EXPLANATIONS.pages}</Notice> : null}

        <div className="currency-setting">
          <span className="currency-setting-label"><Icon name="refresh" size={14} /> How conversion works</span>
          <InfoToggle topic="conversion" open={open === 'conversion'} onToggle={toggle} label="About conversion" />
        </div>
        {open === 'conversion' ? <Notice tone="info">{EXPLANATIONS.conversion}</Notice> : null}

        {error ? <Notice tone="error" role="status">{error}</Notice> : null}
      </div>
    </Panel>
  );
}

/** The ⓘ beside a setting: a button that opens its explanation, named for a screen reader. */
function InfoToggle({ topic, open, onToggle, label }: { topic: Topic; open: boolean; onToggle: (topic: Topic) => void; label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      className="btn btn-icon btn-ghost btn-sm currency-info"
      aria-label={label}
      aria-expanded={open}
      title={label}
      data-testid={`currency-info-${topic}`}
      onClick={() => onToggle(topic)}
    >
      <Icon name="info" size={14} />
    </button>
  );
}
