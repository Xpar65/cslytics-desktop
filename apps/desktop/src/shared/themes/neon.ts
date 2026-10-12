import type { Theme } from './palette.js';

/**
 * Neon: a violet-black grid lit from below, after Tron.
 *
 * The one theme that uses the backdrop as more than a colour. The window's background is a 44px
 * grid of faint violet lines over a magenta glow rising from the bottom edge and a cyan haze at the
 * top, and it shows wherever the page is not a panel: the gutters, the top bar, the space under a
 * short list. Panels stay solid so text never sits on a line, and glow instead of casting a shadow
 * (`--cs-panel-glow`); their hairlines are the accent at low alpha, which is what makes each edge
 * read as lit. The accent is a neon purple; profit is a mint and loss a hot pink, both bright
 * enough to hold their own beside it.
 *
 * `--cs-bg` stays a solid near-black: it is what main paints before the first frame and what a
 * well inside a panel is filled with, and neither can be a gradient.
 */
const GRID = 'rgba(168, 85, 247, 0.17)';

export const neon: Theme = {
  id: 'neon',
  label: 'Neon',
  description: 'Violet neon on a glowing grid',
  scheme: 'dark',
  palette: {
    '--cs-backdrop': [
      `linear-gradient(${GRID} 1px, transparent 1px) 0 0 / 44px 44px`,
      `linear-gradient(90deg, ${GRID} 1px, transparent 1px) 0 0 / 44px 44px`,
      'radial-gradient(ellipse 120% 60% at 50% 115%, rgba(217, 70, 239, 0.40), transparent 70%)',
      'radial-gradient(ellipse 90% 45% at 50% -15%, rgba(34, 211, 238, 0.14), transparent 70%)',
      '#07030F'
    ].join(', '),
    '--cs-bg': '#07030F',
    '--cs-surface': '#110A20',
    '--cs-surface-raised': '#150C28',
    '--cs-surface-inset': '#0C0618',
    '--cs-field': '#090413',
    '--cs-titlebar-bg': '#0C0618',
    '--cs-titlebar-text': '#B9A6DA',

    '--cs-border': 'rgba(192, 132, 252, 0.24)',
    '--cs-border-subtle': 'rgba(192, 132, 252, 0.17)',
    '--cs-border-faint': 'rgba(192, 132, 252, 0.12)',
    '--cs-border-strong': 'rgba(192, 132, 252, 0.40)',

    '--cs-hover': 'rgba(192, 132, 252, 0.09)',
    '--cs-wash': 'rgba(192, 132, 252, 0.04)',

    '--cs-text': '#EDE7FF',
    '--cs-text-muted': '#B9A6DA',
    '--cs-text-faint': '#8E7BB3',
    '--cs-text-strong': '#F8F5FF',
    '--cs-text-on-accent': '#0B0216',
    '--cs-knob': '#EDE7FF',

    '--cs-accent': '#C04BFF',
    '--cs-accent-hover': '#D57CFF',
    '--cs-accent-ink': '#D27BFF',
    '--cs-accent-border': 'rgba(200, 90, 255, 0.50)',
    '--cs-accent-wash': 'rgba(200, 90, 255, 0.15)',
    '--cs-accent-text': '#E9C2FF',

    '--cs-positive': '#3CF5B0',
    '--cs-positive-border': 'rgba(60, 245, 176, 0.35)',
    '--cs-positive-wash': 'rgba(60, 245, 176, 0.08)',
    '--cs-negative': '#FF4D8D',
    '--cs-negative-border': 'rgba(255, 77, 141, 0.40)',
    '--cs-negative-wash': 'rgba(255, 77, 141, 0.08)',

    '--cs-art-glow': 'rgba(20, 0, 40, 0.75)',

    '--cs-scrim': 'rgba(5, 2, 12, 0.80)',
    '--cs-shadow-modal': '0 0 0 1px rgba(200, 90, 255, 0.35), 0 25px 60px -12px rgba(160, 40, 255, 0.45)',
    '--cs-shadow-pop': '0 0 0 1px rgba(200, 90, 255, 0.30), 0 12px 36px -8px rgba(160, 40, 255, 0.40)',
    '--cs-panel-glow': '0 0 28px -4px rgba(176, 64, 255, 0.40)',

    '--wear-fn': '#22E4F5',
    '--wear-mw': '#3CF5B0',
    '--wear-ft': '#E8D27A',
    '--wear-ww': '#FF9D4D',
    '--wear-bs': '#FF4D6D',

    '--cs-hold-wallet': '#5B8CFF',
    '--cs-hold-listed': '#2DE0C8',
    '--cs-hold-unconfirmed': '#E37BFF',
    '--cs-hold-hatch': 'rgba(255, 255, 255, 0.45)',

    '--cs-avatar-bg-sl': '45% 20%',
    '--cs-avatar-ring-sl': '70% 45%',
    '--cs-avatar-text-sl': '70% 85%'
  }
};
