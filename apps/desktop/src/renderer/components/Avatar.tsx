import React, { useEffect, useState } from 'react';
import { cachedImageUrl } from '@cslytics/catalogue';
import type { ConnectionTone } from '../lib/connection.js';
import { avatarHue, initials } from '../lib/labels.js';

/**
 * An account's face.
 *
 * When `photo` is an `avatar:<hash>` reference that `cachedImageUrl` accepts, the face is asked
 * for over `cs-image:` and main serves it from its own store. Initials on a name-derived hue
 * remain the identity mark when there is no hash, or while the picture has never once been
 * reachable — so an account always has a face.
 *
 * `presence` is the connection tone, drawn as the small dot every chat client uses. It is a
 * summary of the weaker of the two connections behind the account, exactly as the account
 * tab's dot is; see `describeConnection`.
 */
export function Avatar({
  name,
  size = 32,
  presence,
  square = false,
  photo
}: {
  name: string;
  size?: number | undefined;
  presence?: ConnectionTone | 'connecting' | undefined;
  square?: boolean | undefined;
  /** `avatar:<40hex>` from accounts.list, or null when the hash has never been observed. */
  photo?: string | null | undefined;
}): React.JSX.Element {
  const hue = avatarHue(name);
  // 64 asks for Steam's 64×64 `_medium`, 96 for its 184×184 `_full`. The threshold
  // is device pixels, not CSS: a 30px chip on a 2× display is 60 real pixels and medium is
  // exactly right, while the 40px panel face wants 80 and would be soft at medium.
  const src = cachedImageUrl(photo ?? null, size >= 34 ? 96 : 64);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setFailed(false); setAttempt(0); }, [photo]);
  // A face that failed once must not stay initials for the life of the window. Main retries the
  // fetch on its own schedule; this is the window's half — bounded, and taken on `online` as well
  // as on a timer because coming back is the answer to the commonest cause.
  useEffect(() => {
    if (!failed || attempt >= 3) return undefined;
    const retry = (): void => { setFailed(false); setAttempt((previous) => previous + 1); };
    window.addEventListener('online', retry);
    const timer = window.setTimeout(retry, 15_000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearTimeout(timer);
    };
  }, [failed, attempt]);
  const showPhoto = Boolean(src) && !failed;

  return (
    <span
      className="avatar"
      data-square={square || undefined}
      data-photo={showPhoto || undefined}
      style={{ '--avatar-hue': hue, width: size, height: size, fontSize: Math.round(size * 0.38) } as React.CSSProperties}
      aria-hidden="true"
    >
      {showPhoto ? (
        <img
          key={src!}
          className="avatar-photo"
          src={src!}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="avatar-initials">{initials(name)}</span>
      )}
      {presence ? <span className="avatar-presence" data-tone={presence} /> : null}
    </span>
  );
}

/** Several accounts at once: up to three overlapping faces and a count for the rest. */
export function AvatarStack({
  accounts,
  size = 26
}: {
  accounts: readonly { name: string; photo?: string | null | undefined }[];
  size?: number | undefined;
}): React.JSX.Element {
  const shown = accounts.slice(0, 3);
  const rest = accounts.length - shown.length;
  return (
    <span className="avatar-stack" aria-hidden="true">
      {shown.map((account) => (
        <Avatar key={account.name} name={account.name} size={size} photo={account.photo} />
      ))}
      {rest > 0 ? <span className="avatar avatar-rest" style={{ width: size, height: size }}>+{rest}</span> : null}
      {accounts.length === 0 ? <span className="avatar avatar-rest" style={{ width: size, height: size }}>·</span> : null}
    </span>
  );
}
