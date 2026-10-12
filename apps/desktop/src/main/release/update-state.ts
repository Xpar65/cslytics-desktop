import type { UpdateState } from '../../shared/release.js';

/**
 * What electron-updater said, reduced to one state the window can show.
 *
 * Pure, so the transitions are testable without Electron; `updater.ts` feeds it the events.
 */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; at: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string; at: string };

export function nextUpdateState(state: UpdateState, event: UpdateEvent): UpdateState {
  // A development run never updates, and nothing it hears changes that.
  if (state.phase === 'disabled') return state;
  // A downloaded update installs when the app quits whatever happens afterwards, so a later check
  // or a failed one must not make the window forget it is there.
  if (state.phase === 'ready') {
    return event.type === 'downloaded' ? { phase: 'ready', version: event.version } : state;
  }
  switch (event.type) {
    case 'checking': return { phase: 'checking' };
    case 'available': return { phase: 'downloading', version: event.version, percent: 0 };
    case 'not-available': return { phase: 'current', checkedAt: event.at };
    case 'progress':
      return state.phase === 'downloading'
        ? { ...state, percent: Math.max(0, Math.min(100, Math.round(event.percent))) }
        : state;
    case 'downloaded': return { phase: 'ready', version: event.version };
    case 'error': return { phase: 'error', message: event.message, at: event.at };
  }
}
