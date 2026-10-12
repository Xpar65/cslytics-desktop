import React, { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon.js';
import type { Tone } from '../lib/labels.js';
import { formatDateTime, formatRelative, humanize, looksLikeDate } from '../lib/labels.js';

/**
 * Shared primitives.
 *
 * Structure follows the Cslytics recipes; colours come from tokens.css and nothing here names
 * one. Every control is a real `<button>` or `<input>` with a real label, because the journeys
 * drive the app the way a screen reader would — by role and name — and a div that looks like a
 * button is invisible to both.
 */

export function Panel({
  children,
  className,
  tone
}: {
  children: React.ReactNode;
  className?: string | undefined;
  tone?: 'default' | 'inset' | undefined;
}): React.JSX.Element {
  return <section className={className ? `panel ${className}` : 'panel'} data-tone={tone}>{children}</section>;
}

/**
 * A panel's heading row. `info` puts an "i" beside the title that opens a short explanation
 * under the header, in place, rather than a tooltip: a tooltip cannot be read with the keyboard,
 * and the panel clips anything that floats out of it.
 */
export function PanelHeader({
  title,
  subtitle,
  icon,
  mark,
  actions,
  badge,
  info
}: {
  title: string;
  subtitle?: React.ReactNode | undefined;
  icon?: IconName | undefined;
  /** A venue mark or other non-stroke glyph. Takes the place of `icon` when given. */
  mark?: React.ReactNode | undefined;
  actions?: React.ReactNode | undefined;
  badge?: React.ReactNode | undefined;
  info?: { label: string; content: React.ReactNode } | undefined;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const infoId = useId();
  return (
    <>
      <header className="panel-header">
        <div className="panel-heading">
          {mark ? <span className="panel-icon">{mark}</span> : icon ? <span className="panel-icon"><Icon name={icon} size={16} /></span> : null}
          <div>
            <div className="panel-title-row">
              <div className="panel-title">{title}</div>
              {info ? (
                <IconButton
                  icon="info"
                  size="sm"
                  label={info.label}
                  className="panel-info-toggle"
                  aria-expanded={open}
                  aria-controls={infoId}
                  data-open={open || undefined}
                  onClick={() => setOpen(!open)}
                />
              ) : null}
              {badge}
            </div>
            {subtitle ? <div className="panel-subtitle">{subtitle}</div> : null}
          </div>
        </div>
        {actions ? <div className="toolbar panel-actions">{actions}</div> : null}
      </header>
      {info && open ? <div className="panel-info" id={infoId} role="region" aria-label={info.label}>{info.content}</div> : null}
    </>
  );
}

export function Field({
  label,
  hint,
  children,
  icon,
  inline = false
}: {
  label: string;
  hint?: React.ReactNode | undefined;
  children: React.ReactNode;
  icon?: IconName | undefined;
  inline?: boolean | undefined;
}): React.JSX.Element {
  return (
    <label className="field" data-inline={inline || undefined}>
      <span className="field-label">{label}</span>
      {icon ? (
        <span className="field-control">
          <span className="field-icon"><Icon name={icon} size={15} /></span>
          {children}
        </span>
      ) : children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Badge({
  children,
  tone,
  icon
}: {
  children: React.ReactNode;
  tone?: Tone | 'warn' | 'accent' | 'quiet' | undefined;
  icon?: IconName | undefined;
}): React.JSX.Element {
  return (
    <span className="badge" data-tone={tone}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

/** A state with a dot and a word. The dot carries the tone; the word carries the meaning. */
export function StatusBadge({
  label,
  tone,
  icon,
  title
}: {
  label: string;
  tone: Tone;
  icon?: IconName | undefined;
  title?: string | undefined;
}): React.JSX.Element {
  return (
    <span className="status-badge" data-tone={tone} title={title}>
      {icon ? <Icon name={icon} size={12} /> : <span className="status-badge-dot" />}
      {label}
    </span>
  );
}

export function Pill({
  selected,
  onClick,
  disabled,
  children,
  icon
}: {
  selected: boolean;
  onClick: () => void;
  disabled?: boolean | undefined;
  children: React.ReactNode;
  icon?: IconName | undefined;
}): React.JSX.Element {
  return (
    <button type="button" className="pill" data-selected={selected} aria-pressed={selected} onClick={onClick} disabled={disabled}>
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </button>
  );
}

/** Mutually exclusive choices in one control, the way a tab strip or a toggle group reads. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label
}: {
  value: T;
  /** An icon by name, or a ready element — a venue's mark is a picture, not a stroke drawing. */
  options: ReadonlyArray<{ id: T; label: string; icon?: IconName | React.ReactElement | undefined; count?: number | undefined }>;
  onChange: (next: T) => void;
  disabled?: boolean | undefined;
  label: string;
}): React.JSX.Element {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          className="segmented-item"
          aria-selected={value === option.id}
          data-selected={value === option.id}
          disabled={disabled}
          onClick={() => onChange(option.id)}
        >
          {typeof option.icon === 'string' ? <Icon name={option.icon} size={14} /> : option.icon ?? null}
          <span>{option.label}</span>
          {option.count !== undefined && option.count > 0 ? <span className="segmented-count num">{option.count.toLocaleString()}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Check({
  checked,
  onChange,
  disabled,
  label,
  indeterminate
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean | undefined;
  label: string;
  indeterminate?: boolean | undefined;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="check"
      data-checked={checked}
      data-indeterminate={indeterminate || undefined}
      aria-label={label}
      aria-pressed={checked}
      disabled={disabled}
      onClick={(event) => { event.stopPropagation(); onChange(); }}
    >
      {checked ? <Icon name="check" size={12} strokeWidth={3} /> : indeterminate ? <Icon name="minus" size={12} strokeWidth={3} /> : null}
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  hint
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean | undefined;
  label: string;
  hint?: string | undefined;
}): React.JSX.Element {
  return (
    <label className="switch-row">
      <span className="switch" data-checked={checked} data-disabled={disabled || undefined}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span className="switch-knob" />
      </span>
      <span>
        <span className="switch-label">{label}</span>
        {hint ? <span className="switch-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Button({
  children,
  variant = 'default',
  icon,
  iconRight,
  loading = false,
  size = 'md',
  type = 'button',
  className,
  ...rest
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  children?: React.ReactNode;
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'subtle' | undefined;
  icon?: IconName | undefined;
  iconRight?: IconName | undefined;
  loading?: boolean | undefined;
  size?: 'sm' | 'md' | 'lg' | undefined;
}): React.JSX.Element {
  const classes = ['btn', `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(' ');
  return (
    <button type={type} className={classes} data-loading={loading || undefined} {...rest} disabled={rest.disabled || loading}>
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
      {children !== undefined ? <span className="btn-label">{children}</span> : null}
      {iconRight && !loading ? <Icon name={iconRight} size={size === 'sm' ? 13 : 15} /> : null}
    </button>
  );
}

/** A button that is only an icon. The label is what it is called; the tooltip repeats it. */
/** Copies `value` to the clipboard, and turns into a tick for a moment so the press is seen to land. */
export function CopyButton({ value, label }: { value: string; label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      icon={copied ? 'check' : 'copy'}
      size="sm"
      label={copied ? 'Copied' : label}
      className="copy-button"
      data-copied={copied || undefined}
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => undefined); }}
    />
  );
}

export function IconButton({
  icon,
  label,
  size = 'md',
  variant = 'ghost',
  className,
  ...rest
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName;
  label: string;
  size?: 'sm' | 'md' | undefined;
  variant?: 'ghost' | 'default' | 'subtle' | undefined;
}): React.JSX.Element {
  return (
    <button type="button" className={['btn', 'btn-icon', `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(' ')} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size === 'sm' ? 14 : 16} />
    </button>
  );
}

export function Spinner({ size = 16, label }: { size?: number | undefined; label?: string | undefined }): React.JSX.Element {
  return <span className="spinner" style={{ width: size, height: size }} role={label ? 'status' : undefined} aria-label={label}><Icon name="loader" size={size} strokeWidth={2.25} /></span>;
}

export function Skeleton({ width, height = 14, className }: { width?: number | string | undefined; height?: number | undefined; className?: string | undefined }): React.JSX.Element {
  return <span className={className ? `skeleton ${className}` : 'skeleton'} style={{ width: width ?? '100%', height }} aria-hidden="true" />;
}

export function Metric({
  label,
  value,
  note,
  icon,
  tone
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode | undefined;
  icon?: IconName | undefined;
  tone?: 'accent' | 'positive' | 'negative' | undefined;
}): React.JSX.Element {
  return (
    <article className="metric" data-tone={tone}>
      {icon ? <span className="metric-icon"><Icon name={icon} size={14} /></span> : null}
      <div className="metric-label">{label}</div>
      <div className="metric-value num">{value}</div>
      {note ? <div className="metric-note">{note}</div> : null}
    </article>
  );
}

export function Empty({
  title,
  hint,
  icon = 'inbox',
  action
}: {
  title: string;
  hint?: React.ReactNode | undefined;
  icon?: IconName | undefined;
  action?: React.ReactNode | undefined;
}): React.JSX.Element {
  const loading = icon === 'loader';
  return (
    <div className="empty" data-loading={loading || undefined}>
      <span className="empty-icon">{loading ? <Spinner size={22} label={title} /> : <Icon name={icon} size={22} />}</span>
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {loading ? <span className="empty-loading-bar" aria-hidden="true" /> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/** What a view says back after a click: shown once, in a `Notice`, where the click happened. */
export type Message = { tone: 'success' | 'error' | 'info'; title: string; detail?: string };

/**
 * Something the user must read: a failure, a warning, or a fact about why a screen is quiet.
 *
 * `unknown` is the tone for an ambiguous outcome. Nothing was observed, so the notice must not
 * dress it up as a failure — the same reason the sign-in screen distinguishes the two.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  role
}: {
  tone?: 'info' | 'warn' | 'error' | 'success' | 'unknown' | undefined;
  title?: React.ReactNode | undefined;
  children?: React.ReactNode | undefined;
  action?: React.ReactNode | undefined;
  role?: 'status' | 'alert' | undefined;
}): React.JSX.Element {
  const icon: IconName = tone === 'error' ? 'x-circle' : tone === 'warn' ? 'alert-triangle' : tone === 'success' ? 'check-circle' : tone === 'unknown' ? 'alert-circle' : 'info';
  return (
    <div className="notice" data-tone={tone} role={role}>
      <span className="notice-icon"><Icon name={icon} size={16} /></span>
      <div className="notice-body">
        {title ? <div className="notice-title">{title}</div> : null}
        {children ? <div className="notice-detail">{children}</div> : null}
      </div>
      {action ? <div className="notice-action">{action}</div> : null}
    </div>
  );
}

/** A definition list laid out as label / value rows. */
export function KeyValue({ rows, columns = 1 }: { rows: ReadonlyArray<{ label: string; value: React.ReactNode; mono?: boolean }>; columns?: 1 | 2 | undefined }): React.JSX.Element {
  return (
    <dl className="kv" data-columns={columns}>
      {rows.map((row) => (
        <div className="kv-row" key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.mono ? 'mono' : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A record the engine returned, rendered as rows rather than as JSON.
 *
 * Keys are humanised, timestamps are formatted, nested lists become tables, and internal
 * identifiers land in a collapsed "Technical details" section so they are there for support
 * without being the first thing on screen.
 */
const TECHNICAL_KEYS = new Set(['accountId', 'localId', 'sourceKey', 'rowKey', 'stackKey', 'matchKey', 'observationId', 'actionId', 'correctsSourceKey', 'eventId', 'requestId', 'revision', 'venueOrderId', 'assetId', 'newAssetId', 'defIndex', 'paintIndex', 'quality', 'kit', 'generation', 'id', 'local_id', 'account_id', 'def_index', 'paint_index', 'quality_id', 'observation_id']);
const MONEY_KEYS = /cents$/i;

function renderValue(key: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === '') return <span className="quiet">—</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (MONEY_KEYS.test(key)) return `${(value / 100).toFixed(2)}`;
    return value.toLocaleString();
  }
  if (looksLikeDate(value)) return <span title={value}>{formatDateTime(value)} <span className="quiet">· {formatRelative(value)}</span></span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="quiet">None</span>;
    if (typeof value[0] === 'object' && value[0] !== null) {
      const keys = Object.keys(value[0] as Record<string, unknown>).filter((column) => !TECHNICAL_KEYS.has(column));
      return (
        <div className="table-scroll">
          <table className="table">
            <thead><tr>{keys.map((column) => <th key={column}>{humanize(column)}</th>)}</tr></thead>
            <tbody>
              {value.map((row, index) => (
                <tr key={index}>{keys.map((column) => <td key={column}>{renderValue(column, (row as Record<string, unknown>)[column])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return value.map(String).join(', ');
  }
  if (typeof value === 'object') return <DetailView data={value} nested />;
  const text = String(value);
  return /^[A-Z][A-Z_]+$/.test(text) ? humanize(text) : text;
}

export function DetailView({ data, nested = false }: { data: unknown; nested?: boolean | undefined }): React.JSX.Element {
  if (data === null || data === undefined) return <Empty title="Nothing recorded" hint="The engine has no row for this reference." icon="file-text" />;
  if (typeof data !== 'object') return <div>{String(data)}</div>;
  const entries = Object.entries(data as Record<string, unknown>);
  const shown = entries.filter(([key]) => !TECHNICAL_KEYS.has(key) && key !== 'kind');
  const technical = entries.filter(([key]) => TECHNICAL_KEYS.has(key));
  return (
    <div className="detail-view" data-nested={nested || undefined}>
      <KeyValue rows={shown.map(([key, value]) => ({ label: humanize(key), value: renderValue(key, value) }))} />
      {technical.length > 0 && !nested ? (
        <details className="technical">
          <summary><Icon name="chevron-right" size={13} /> Technical details</summary>
          <KeyValue rows={technical.map(([key, value]) => ({ label: humanize(key), value: value === null ? '—' : String(value), mono: true }))} />
        </details>
      ) : null}
    </div>
  );
}

/**
 * A panel that slides in from the right edge with one thing in it.
 *
 * Used for anything that is *about* a row — an item's details, a group's copies, a record —
 * so the list it came from stays where it was. Escape and the scrim both close it. It is
 * portalled to the document body: an animated ancestor would otherwise become its containing
 * block and pin the drawer inside the panel that opened it.
 */
export function Drawer({
  open,
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  wide = false
}: {
  open: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode | undefined;
  icon?: IconName | undefined;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode | undefined;
  wide?: boolean | undefined;
}): React.JSX.Element | null {
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="drawer-root">
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} data-wide={wide || undefined}>
        <header className="drawer-head">
          {icon ? <span className="panel-icon"><Icon name={icon} size={16} /></span> : null}
          <div className="drawer-heading">
            <div className="drawer-title" id={titleId}>{title}</div>
            {subtitle ? <div className="drawer-subtitle">{subtitle}</div> : null}
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <footer className="drawer-foot">{footer}</footer> : null}
      </aside>
    </div>,
    document.body
  );
}

/**
 * A dialog in the middle of the window, over everything else (style guide, Modal).
 *
 * For a question that has to be answered before anything else happens, which a drawer is not:
 * a drawer is *about* a row and leaves the list usable. Escape and the scrim close it unless
 * `dismissable` is false — while the thing it asked about is running, closing it would hide the
 * answer. The page behind does not scroll while it is open.
 */
export function Modal({
  open,
  title,
  icon,
  onClose,
  children,
  footer,
  dismissable = true
}: {
  open: boolean;
  title: React.ReactNode;
  icon?: IconName | undefined;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode | undefined;
  dismissable?: boolean | undefined;
}): React.JSX.Element | null {
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && dismissable) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, dismissable]);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="modal-root">
      <div className="modal-scrim" onClick={dismissable ? onClose : undefined} />
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-head">
          {icon ? <span className="panel-icon"><Icon name={icon} size={16} /></span> : null}
          <div className="modal-title" id={titleId}>{title}</div>
          <IconButton icon="x" label="Close" disabled={!dismissable} onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </section>
    </div>,
    document.body
  );
}

/**
 * A confirmation for something that cannot be undone.
 *
 * The danger button stays disabled until `phrase` is typed exactly, so a person has read at least
 * the name of what they are about to lose. `onConfirm` throwing keeps the dialog open with the
 * reason in it; nothing closes it while it runs.
 */
export function ConfirmDialog({
  open,
  title,
  phrase,
  confirmLabel,
  busyLabel,
  blocked,
  onConfirm,
  onClose,
  children
}: {
  open: boolean;
  title: React.ReactNode;
  phrase: string;
  confirmLabel: string;
  busyLabel: string;
  /** Why it cannot be done right now; shown in place of the prompt, with the button disabled. */
  blocked?: string | null | undefined;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setTyped('');
    setError(null);
  }, [open]);
  const matches = typed.trim() === phrase && !blocked;
  const confirm = async (): Promise<void> => {
    if (!matches || running) return;
    setRunning(true);
    setError(null);
    try {
      await onConfirm();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRunning(false);
    }
  };
  return (
    <Modal
      open={open}
      title={title}
      icon="alert-triangle"
      onClose={onClose}
      dismissable={!running}
      footer={(
        <>
          <Button disabled={running} onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={running} disabled={!matches} onClick={() => void confirm()}>
            {running ? busyLabel : confirmLabel}
          </Button>
        </>
      )}
    >
      {children}
      {blocked ? <Notice tone="warn" role="status">{blocked}</Notice> : null}
      <Field label={`Type ${phrase} to confirm`}>
        <input
          className="input"
          value={typed}
          disabled={running || Boolean(blocked)}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void confirm(); }}
        />
      </Field>
      {error ? <Notice tone="error" role="alert">{error}</Notice> : null}
    </Modal>
  );
}

export function ProgressBar({ value, max, tone, label }: { value: number; max: number; tone?: 'accent' | 'positive' | 'warn' | undefined; label?: string | undefined }): React.JSX.Element {
  const share = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="progress-bar" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label} data-tone={tone}>
      <div className="progress-bar-fill" style={{ width: `${share}%` }} />
    </div>
  );
}

/**
 * Spacing between retries of a picture that did not arrive, and how many there are.
 *
 * A failure used to be permanent: one `onerror` latched the tile off for the life of the
 * component, so a window opened a second before the network came up showed placeholders until it
 * was scrolled out of existence. Main now keeps its own backoff and serves from its own store, so
 * these attempts are cheap — the second one is usually a disk read — and they stop, because a tile
 * that retries forever is a different bug.
 */
const RETRY_MS = [3_000, 12_000, 45_000];

/**
 * A picture that has not loaded is a labelled placeholder, never a blank cell or a gap.
 *
 * `standIn` is a smaller picture of the same thing that this window already holds, such as the
 * list-size handle the tile beside it is drawing. It shows at once while `url` is on its way, and
 * stays if `url` fails, so a panel that asks for a sharper picture never looks emptier than the
 * tile it came from. The swap is immediate rather than faded: both are the same picture in the
 * same box, so it reads as the image sharpening, where a fade would dim it first.
 */
export function Thumbnail({ url, name, size = 44, fill, standIn }: {
  url: string | null;
  name: string;
  size?: number | undefined;
  fill?: boolean | undefined;
  standIn?: string | null | undefined;
}): React.JSX.Element {
  const [shown, setShown] = useState(url);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // A new picture starts clean in the render that brings it, never in an effect after it. An
  // effect runs after the commit, and a picture this window already holds fires `load` before
  // then: the reset landed on top of the load and the image sat at opacity 0 for good. Tiles are
  // keyed by account, so switching accounts remounted every one onto a cached picture — and the
  // inspector keeps a selected item's picture on screen, which made that certain.
  if (shown !== url) {
    setShown(url);
    setAttempt(0);
    setFailed(false);
    setLoaded(false);
  }

  useEffect(() => {
    if (!failed || !url) return undefined;
    const retry = (): void => {
      setFailed(false);
      setAttempt((previous) => previous + 1);
    };
    // Coming back online is the answer to the commonest cause, so it is worth more than the timer:
    // take it immediately rather than sitting out the rest of a backoff that has been overtaken.
    window.addEventListener('online', retry);
    const delay = RETRY_MS[attempt];
    const timer = delay === undefined ? undefined : window.setTimeout(retry, delay);
    return () => {
      window.removeEventListener('online', retry);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [failed, url, attempt]);

  const box = fill ? undefined : { width: size, height: size };
  const fallback = standIn && standIn !== url ? standIn : null;
  if (!url || (failed && !fallback)) {
    return (
      <span className="item-thumbnail item-thumbnail-empty" style={box} data-fill={fill || undefined} aria-label="Image unavailable" role="img">
        <Icon name="image-off" size={fill ? 36 : Math.round(size * 0.4)} />
      </span>
    );
  }
  return (
    <span className="item-thumbnail" style={box} data-loaded={loaded} data-fill={fill || undefined} data-stand-in={fallback ? true : undefined}>
      {fallback && !loaded ? (
        <img className="item-thumbnail-stand-in" src={fallback} alt={failed ? name : ''} aria-hidden={failed ? undefined : true} decoding="async" />
      ) : null}
      {/* `key` forces a fresh element per attempt: re-rendering the same src on a failed <img>
          does not make the browser try again. */}
      {failed ? null : (
        <img key={attempt} src={url} alt={name} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
      )}
    </span>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  label,
  width
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string | undefined;
  label: string;
  width?: number | undefined;
}): React.JSX.Element {
  return (
    <span className="search" style={width ? { width } : undefined}>
      <Icon name="search" size={15} className="search-icon" />
      <input className="input search-input" aria-label={label} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
      {value ? <button type="button" className="search-clear" aria-label="Clear search" onClick={() => onChange('')}><Icon name="x" size={13} /></button> : null}
    </span>
  );
}

export function Select({
  value,
  onChange,
  children,
  label,
  disabled,
  className
}: {
  value: string;
  onChange: (next: string) => void;
  children: React.ReactNode;
  label: string;
  disabled?: boolean | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <span className={className ? `select-wrap ${className}` : 'select-wrap'}>
      <select className="select" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <Icon name="chevron-down" size={14} className="select-chevron" />
    </span>
  );
}

/** A section heading inside a page, above a group of panels. */
export function SectionTitle({ children, icon, actions }: { children: React.ReactNode; icon?: IconName | undefined; actions?: React.ReactNode | undefined }): React.JSX.Element {
  return (
    <div className="section-title">
      <span className="section-title-text">
        {icon ? <Icon name={icon} size={14} /> : null}
        {children}
      </span>
      {actions}
    </div>
  );
}

/** A quiet inline caption with an icon in front, for meta lines. */
export function Caption({ icon, children, tone }: { icon?: IconName | undefined; children: React.ReactNode; tone?: 'quiet' | 'warn' | 'accent' | 'positive' | undefined }): React.JSX.Element {
  return (
    <span className="caption" data-tone={tone}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}
