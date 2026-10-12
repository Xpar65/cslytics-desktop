import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/Icon.js';
import { Button, IconButton } from '../../components/ui.js';
import { NOTIFICATION_KINDS } from './kinds.js';
import { useNotifications } from './NotificationProvider.js';
import { toasts } from './model.js';

/**
 * The moment's indication: toasts in the top-right, beneath the account strip, newest on top.
 *
 * A toast leaves on its own after its severity's lifetime, or when its × or its action is
 * pressed, and the only thing left behind is the bell's count. At most three are shown; the rest
 * are one line that says how many more the bell holds.
 *
 * The container is always mounted so the live region exists before anything lands in it.
 */
export function NotificationStack(): React.JSX.Element {
  const { state, now, closeToast, navigate } = useNotifications();
  const { visible, overflow } = toasts(state, now);

  return createPortal(
    <div className="notification-stack" aria-live="polite" aria-label="Notifications">
      {visible.map((row) => (
        // Keyed by raise time too, so a condition that comes back animates in again.
        <div
          key={`${row.id}:${row.raisedAt}`}
          className="toast"
          data-severity={row.severity}
          data-kind={row.kind}
          role={row.severity === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-icon"><Icon name={NOTIFICATION_KINDS[row.kind].icon} size={16} /></span>
          <div className="toast-body">
            <div className="toast-title">{row.title}</div>
            <div className="toast-detail">{row.body}</div>
            {row.action ? (
              <div className="toast-action">
                <Button
                  size="sm"
                  variant="ghost"
                  iconRight="arrow-right"
                  onClick={() => { closeToast(row.id); navigate(row.action!.route); }}
                >
                  {row.action.label}
                </Button>
              </div>
            ) : null}
          </div>
          <IconButton icon="x" size="sm" label={`Dismiss: ${row.title}`} onClick={() => closeToast(row.id)} />
        </div>
      ))}
      {overflow > 0 ? (
        <div className="toast toast-more" role="status">+{overflow} more · open the bell to see them all</div>
      ) : null}
    </div>,
    document.body
  );
}
