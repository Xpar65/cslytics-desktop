import React, { useState } from 'react';
import { Icon } from '../../components/Icon.js';
import { NotificationCentre } from './NotificationCentre.js';
import { useNotifications } from './NotificationProvider.js';
import { unseenCount } from './model.js';

/**
 * The bell, in the top-right of the window beside the work indicator.
 *
 * The indicator says what is happening; the bell says what happened. It is always present — a
 * count is a fact about the record, not about the moment — and opening it is what clears the
 * count: a toast leaving on its own says nothing about whether anyone read it.
 */
export function NotificationBell(): React.JSX.Element {
  const { state, markAllSeen } = useNotifications();
  const [open, setOpen] = useState(false);
  const unseen = unseenCount(state);
  const label = unseen > 0 ? `Notifications, ${unseen} new` : 'Notifications';

  return <>
    <button
      type="button"
      className="notification-bell"
      data-unseen={unseen > 0 ? 'true' : undefined}
      aria-label={label}
      title={unseen > 0 ? `${unseen} new. Open to see what the app has told you.` : 'Nothing new. Open to see what the app has told you.'}
      onClick={() => { markAllSeen(); setOpen(true); }}
    >
      <Icon name="bell" size={15} />
      {unseen > 0 ? <span className="notification-badge num" aria-hidden="true">{unseen > 99 ? '99+' : unseen}</span> : null}
    </button>
    <NotificationCentre open={open} onClose={() => setOpen(false)} />
  </>;
}
