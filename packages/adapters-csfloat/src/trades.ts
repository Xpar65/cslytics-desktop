import type { AccountId, CredentialVault, CsfloatCredentialRef, CsfloatTrade, CsfloatTradePort } from '@cslytics/ports';
import { CsfloatTransport, requireKey } from './transport.js';
import { id, mutationResult, readResult, record, timestamp } from './outcome.js';
import { readListing } from './listings.js';

export class CsfloatTradeAdapter implements CsfloatTradePort {
  constructor(private readonly vault: CredentialVault, private readonly transport = new CsfloatTransport()) {}
  async getTrades(accountId: AccountId, credential: CsfloatCredentialRef, state: string) {
    const query = new URLSearchParams({ state, limit: '5000' });
    return readResult(await this.transport.send({ accountId, method: 'GET', path: `/me/trades?${query}`, key: await requireKey(this.vault, credential) }), readTrades);
  }
  async getTrade(accountId: AccountId, credential: CsfloatCredentialRef, tradeId: string) {
    return readResult(await this.transport.send({ accountId, method: 'GET', path: `/trades/${encodeURIComponent(tradeId)}`, key: await requireKey(this.vault, credential) }), readTrade);
  }
  async accept(accountId: AccountId, credential: CsfloatCredentialRef, tradeId: string) {
    return mutationResult(await this.transport.send({ accountId, method: 'POST', path: '/trades/bulk/accept', key: await requireKey(this.vault, credential), body: { trade_ids: [tradeId] } }),
      body => { const data = record(body)?.['data']; return Array.isArray(data) && data.length === 1 && record(data[0])?.['id'] === tradeId && record(data[0])?.['state'] === 'pending'; });
  }
  async notifyOffer(accountId: AccountId, credential: CsfloatCredentialRef, offerId: string, assetIds: readonly string[]) {
    return mutationResult(await this.transport.send({ accountId, method: 'POST', path: '/trades/steam-status/new-offer', key: await requireKey(this.vault, credential),
      body: { offer_id: offerId, given_asset_ids: assetIds, received_asset_ids: [] } }), body => record(body)?.['message'] === 'successfully updated offer state');
  }
  async cannotDeliver(accountId: AccountId, credential: CsfloatCredentialRef, tradeId: string) {
    return mutationResult(await this.transport.send({ accountId, method: 'POST', path: `/trades/${encodeURIComponent(tradeId)}/cannot-deliver`, key: await requireKey(this.vault, credential) }),
      body => record(body)?.['id'] === tradeId && record(body)?.['state'] === 'failed');
  }
}

export function readTrade(body: unknown): CsfloatTrade | null {
  const value = record(body);
  if (!value) return null;
  const tradeId = id(value['id']), listingId = id(value['contract_id']), seller = id(value['seller_id']), buyer = id(value['buyer_id']);
  const listing = readListing(value['contract']), createdAt = timestamp(value['created_at']);
  if (!tradeId || !listingId || !seller || seller.length !== 17 || !buyer || buyer.length !== 17 || !listing || listing.listingId !== listingId || !createdAt || typeof value['state'] !== 'string') return null;
  const offer = record(value['steam_offer']);
  return { tradeId, listingId, sellerSteamId: seller, buyerSteamId: buyer, listing,
    state: value['state'], createdAt, acceptedAt: timestamp(value['accepted_at']),
    offerId: id(offer?.['id']), offerState: typeof offer?.['state'] === 'number' && Number.isSafeInteger(offer['state']) ? offer['state'] : null,
    deadlineAt: timestamp(offer?.['deadline_at']), verificationMode: typeof value['verification_mode'] === 'string' ? value['verification_mode'] : null,
    verifySaleAt: timestamp(value['verify_sale_at']), tradeToken: typeof value['trade_token'] === 'string' && /^[A-Za-z0-9_-]{8}$/.test(value['trade_token']) ? value['trade_token'] : null };
}

export function readTrades(body: unknown): { trades: CsfloatTrade[]; count: number } | null {
  const value = record(body);
  if (!value || !Array.isArray(value['trades']) || typeof value['count'] !== 'number' || !Number.isSafeInteger(value['count']) || value['count'] < 0) return null;
  const trades: CsfloatTrade[] = [], ids = new Set<string>();
  for (const raw of value['trades']) {
    const trade = readTrade(raw);
    if (!trade || ids.has(trade.tradeId)) return null;
    ids.add(trade.tradeId); trades.push(trade);
  }
  return { trades, count: value['count'] };
}
