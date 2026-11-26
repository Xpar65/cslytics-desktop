import type { CsfloatBudgetPort, CsfloatBudgetState } from '@cslytics/ports';
import type { CsfloatTransport } from './transport.js';

/** The shared counter as the transport every CSFloat adapter of this process sends through last heard it. */
export class CsfloatBudgetAdapter implements CsfloatBudgetPort {
  constructor(private readonly transport: CsfloatTransport) {}

  state(): CsfloatBudgetState {
    return this.transport.budget();
  }
}
