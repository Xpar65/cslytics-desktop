import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { chipAccounts, type FilterChip, type ScopeAccount } from './filter-grammar.js';

/**
 * A filter bar's chips over the scope the sidebar names, shared by every screen that has one.
 *
 * A unit or account chip names an account, and the sidebar can take that account out of view
 * under it. Such a chip is neither shown nor applied while it is out of view, rather than quietly
 * narrowing the new scope to nothing; it comes back when the account does.
 *
 * `scope` and `queryScope` are the joined forms, because the account array is rebuilt on every
 * render of the shell and a dependency on it would re-read every time. `queryScope` is the scope
 * narrowed by any account chips, and is never empty while the scope is not (`chipAccounts`).
 */
export function useScopedChips(accountIds: readonly string[], accounts: readonly ScopeAccount[]): {
  chips: FilterChip[];
  setChips: Dispatch<SetStateAction<FilterChip[]>>;
  scope: string;
  queryScope: string;
  /** The accounts a chip may name. Naming the only account in view would add a chip that narrows nothing. */
  scopeAccounts: ScopeAccount[];
} {
  const [stored, setChips] = useState<FilterChip[]>([]);
  const scope = accountIds.join('\0');
  const chips = useMemo(
    () => stored.filter((chip) => chip.accountId === undefined || scope.split('\0').includes(chip.accountId)),
    [stored, scope]
  );
  const queryScope = chipAccounts(chips, scope.split('\0')).join('\0');
  const scopeAccounts = useMemo(() => {
    const ids = scope.split('\0');
    return ids.length > 1 ? accounts.filter((account) => ids.includes(account.id)) : [];
  }, [accounts, scope]);
  return { chips, setChips, scope, queryScope, scopeAccounts };
}
