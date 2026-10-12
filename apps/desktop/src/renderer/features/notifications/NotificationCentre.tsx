import React from 'react';
import { Icon } from '../../components/Icon.js';
import { Drawer, Empty } from '../../components/ui.js';
import { relativeTime } from '../../lib/format.js';
import { NOTIFICATION_KINDS } from './kinds.js';
import { useNotifications } from './NotificationProvider.js';
import { centre, type Notification, type Route } from './model.js';

/**
 * The record, behind the bell: what holds right now, then what happened earlier, newest first.
 *
 * A row whose kind has an action is a button and goes there; a row without one is information
 * and a click does nothing, which is deliberate rather than unfinished — "cannot connect" has
 * nowhere to send anyone yet.
 */
export function NotificationCentre({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const { state, navigate } = useNotifications();
  const groups = centre(state);
  const go = (route: Route): void => { onClose(); navigate(route); };

  return (
    <Drawer
      open={open}
      icon="bell"
      title="Notifications"
      subtitle="What the app raised on its own, whether or not you were looking."
      onClose={onClose}
    >
      {groups.now.length === 0 && groups.earlier.length === 0 ? (
        <Empty icon="bell" title="Nothing yet" hint="Messages the app raises on its own are kept here." />
      ) : null}
      {groups.now.length > 0 ? <Group title="Now" rows={groups.now} onGo={go} /> : null}
      {groups.earlier.length > 0 ? <Group title="Earlier" rows={groups.earlier} onGo={go} /> : null}
    </Drawer>
  );
}

function Group({ title, rows, onGo }: { title: string; rows: readonly Notification[]; onGo: (route: Route) => void }): React.JSX.Element {
  return (
    <section className="notification-group" aria-label={title}>
      <h3 className="notification-group-title">{title}</h3>
      <ul className="notification-list">
        {rows.map((row) => <Row key={row.id} row={row} onGo={onGo} />)}
      </ul>
    </section>
  );
}

function Row({ row, onGo }: { row: Notification; onGo: (route: Route) => void }): React.JSX.Element {
  const when = row.resolvedAt
    ? `Resolved ${clock(row.resolvedAt)}`
    : row.shape === 'condition' ? `Since ${clock(row.raisedAt)}` : relativeTime(row.raisedAt);
  const body = <>
    <span className="notification-row-icon"><Icon name={NOTIFICATION_KINDS[row.kind].icon} size={15} /></span>
    <span className="notification-row-body">
      <span className="notification-row-title">{row.title}</span>
      <span className="notification-row-detail">{row.body}</span>
      <span className="notification-row-meta">
        <span>{when}</span>
        {row.action ? <span className="notification-row-go">{row.action.label}</span> : null}
      </span>
    </span>
  </>;
  return (
    <li data-notification-id={row.id} data-kind={row.kind}>
      {row.action ? (
        <button type="button" className="notification-row" data-severity={row.severity} onClick={() => onGo(row.action!.route)}>
          {body}
        </button>
      ) : (
        <div className="notification-row" data-severity={row.severity}>{body}</div>
      )}
    </li>
  );
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
