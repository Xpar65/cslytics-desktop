import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PageEnvelope, TradeFlowFilter, TradeOriginClass, TradeStage } from '@cslytics/engine';
import { PagedRows } from '../../components/PagedRows.js';
import { Thumbnail } from '../../components/ui.js';
import { Avatar } from '../../components/Avatar.js';
import { Icon } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import { formatRelative } from '../../lib/labels.js';
import { StageIcon } from './StageIcon.js';
import { TRADE_FLOW, quantityLine, rowPreviews, stageBadge, tradeKey, tradeQuantity, tradeTitle, type NamedTradeRow } from './trade-state.js';

type AccountName = { id: string; name: string; avatarRef?: string | null | undefined };

/**
 * The rail: every trade the filters leave, newest first, one keyset page at a time.
 *
 * Condensed on purpose. It shares the page with the trade and, when an item is open, the inspector,
 * so a row is two lines: what the trade was for, then its state, its size and how long ago. Its
 * pictures say what moved — the first item, a second when there is more than one, an ellipsis past
 * two — and the arrow on their corner which way. The filters that pick the rows sit above the page,
 * the way Listings and Buy orders keep theirs.
 *
 * Only the first page is read on opening, and the rest as the list is scrolled: an account with years
 * of trades must not pay for all of them to open the page. `revision` re-reads the list when a walk
 * lands, but only while it shows its first page: past that, someone is reading back through the
 * history, and a re-read would throw them to the top (the list's own refresh button does that when
 * asked).
 */
export function TradeList({ accountIds, accounts, stage, origin, flow, selectedKey, onSelect, onFirstRows, revision }: {
  accountIds: readonly string[];
  accounts: readonly AccountName[];
  stage: TradeStage | null;
  origin: TradeOriginClass | null;
  flow: TradeFlowFilter | null;
  selectedKey: string | null;
  onSelect: (row: NamedTradeRow) => void;
  /** Each page's rows, so the page can open the newest trade when nothing is chosen yet. */
  onFirstRows: (rows: NamedTradeRow[]) => void;
  revision: number;
}): React.JSX.Element {
  const scope = accountIds.join('\0');
  const deep = useRef(false);
  const [applied, setApplied] = useState(revision);
  useEffect(() => { if (!deep.current) setApplied(revision); }, [revision]);
  const load = useCallback(async (cursor?: string) => {
    // A page past the first is someone scrolling back; the first page again — a filter, the refresh
    // button, a notice — is the top of the list.
    deep.current = Boolean(cursor);
    return await window.trading.invoke({
      type: 'trades.list', accountIds: scope.split('\0'),
      ...(stage ? { stage } : {}), ...(origin ? { origin } : {}), ...(flow ? { flow } : {}), ...(cursor ? { cursor } : {})
    }) as PageEnvelope<NamedTradeRow>;
  }, [scope, stage, origin, flow, applied]);
  const nameOf = (id: string | null): string | null => (id === null ? null : accounts.find((account) => account.id === id)?.name ?? id);
  const photoOf = (id: string): string | null | undefined => accounts.find((account) => account.id === id)?.avatarRef;
  const multiAccount = accountIds.length > 1;
  const filtered = Boolean(stage || origin || flow);

  return (
    <aside className="trade-rail" aria-label="Trades">
      <PagedRows<NamedTradeRow>
        key={`${stage ?? ''}:${origin ?? ''}:${flow ?? ''}`}
        infinite
        noun="trades"
        viewportCap={640}
        load={load}
        rowKey={tradeKey}
        onPage={(page) => onFirstRows(page.rows)}
        emptyTitle={filtered ? 'No trades match these filters' : 'No trades yet'}
        emptyHint={filtered
          ? 'Try another direction, kind or state, or reset the filters.'
          : 'Trades appear here once an account\'s trade offers and history have been read.'}
        render={(row) => {
          const key = tradeKey(row);
          const selected = key === selectedKey;
          const state = stageBadge(row);
          const direction = TRADE_FLOW[row.flow];
          const account = nameOf(row.accountId)!;
          const title = tradeTitle(row, nameOf(row.peerAccountId));
          const previews = rowPreviews(row);
          const said = [title, direction?.label, state.label].filter(Boolean);
          return (
            <button
              type="button"
              className="trade-row"
              data-selected={selected || undefined}
              aria-current={selected || undefined}
              aria-label={said.join(', ')}
              // Folded to its thumbnail beside an open item, the row is named by this alone.
              title={[said.join(' · '), state.hint].join('\n')}
              onClick={() => onSelect(row)}
            >
              <span className="trade-row-thumbs" data-pictures={previews.pictures.length}>
                {previews.pictures.map((picture, index) => (
                  <span className="trade-row-thumb" key={index}>
                    <Thumbnail url={picture.imageUrl} name={picture.name} size={26} />
                  </span>
                ))}
                {previews.more ? <span className="trade-row-more" aria-hidden="true"><Icon name="more" size={14} /></span> : null}
                {direction ? <span className="trade-row-flow" data-flow={row.flow} aria-hidden="true"><Icon name={direction.icon} size={10} /></span> : null}
                {row.originClass === 'marketplace' ? <span className="trade-row-venue"><VenueMark venue="csfloat" size={12} decorative /></span> : null}
                {row.originClass === 'transfers' ? <span className="trade-row-venue"><Icon name="arrow-left-right" size={10} /></span> : null}
              </span>
              <span className="trade-row-text">
                <span className="trade-row-title">{title}</span>
                <span className="trade-row-meta">
                  <span className="trade-stage" data-tone={state.tone}><StageIcon name={state.icon} size={12} />{state.label}</span>
                  {/* One picture or two say how many; past two, or with none recorded, the count does. */}
                  {previews.more || tradeQuantity(row) === 0 ? <span className="trade-row-count">{quantityLine(row)}</span> : null}
                  <span className="quiet">{formatRelative(row.sortAt)}</span>
                </span>
              </span>
              {multiAccount ? <span className="trade-row-account" title={account}><Avatar name={account} size={18} photo={photoOf(row.accountId)} /></span> : null}
            </button>
          );
        }}
      />
    </aside>
  );
}
