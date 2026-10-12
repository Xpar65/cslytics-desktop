import React from 'react';
import tradeProtected from '../../assets/trade-protected.png';
import { Icon } from '../../components/Icon.js';
import type { Tone } from '../../lib/labels.js';
import type { StageIconName } from './trade-state.js';

/**
 * A stage's mark. The reversal period is Steam's own badge — the yellow shield with two arrows the
 * Steam client shows on a trade-protected item — so a person recognises it from Steam itself; every
 * other stage is a stroke icon like the rest of the window.
 */
export function StageIcon({ name, size = 14 }: { name: StageIconName; size?: number | undefined }): React.JSX.Element {
  if (name === 'trade-protected') {
    return <img className="stage-icon" src={tradeProtected} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
  }
  return <Icon name={name} size={size} />;
}

/** `StatusBadge`, for a stage: the mark and the word, in the stage's tone. */
export function StageBadge({ label, tone, icon, title }: { label: string; tone: Tone; icon: StageIconName; title?: string | undefined }): React.JSX.Element {
  return (
    <span className="status-badge stage-badge" data-tone={tone} title={title}>
      <StageIcon name={icon} size={12} />
      {label}
    </span>
  );
}
