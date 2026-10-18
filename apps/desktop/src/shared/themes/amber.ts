import type { Theme } from './palette.js';

/**
 * Easy on the eyes: the dark theme with the blue taken out.
 *
 * Every surface is a warm brown-black and every grey is a parchment tone, so the window emits as
 * little short-wavelength light as a working theme can — the same idea as a night-light filter,
 * but with text that stays the colour it was meant to be. Contrast is kept to the house floor and
 * no further: the text is cream rather than white, and the accent is a soft orange rather than the
 * house amber, which would read as just another shade of the text here. P&L keeps a green and a
 * red, warmed but still told apart; the wear and holdings ramps keep their one cool hue each, as
 * data, because a ramp with no cool end cannot be read.
 */
export const amber: Theme = {
  id: 'amber',
  label: 'Amber',
  description: 'Warm and low in blue light, for long evenings',
  scheme: 'dark',
  palette: {
    '--cs-backdrop': '#14100B',
    '--cs-bg': '#14100B',
    '--cs-surface': '#1C160F',
    '--cs-surface-raised': '#211A12',
    '--cs-surface-inset': '#18130D',
    '--cs-field': '#120E09',
    '--cs-titlebar-bg': '#18130D',
    '--cs-titlebar-text': '#B5A483',

    '--cs-border': 'rgba(255, 214, 153, 0.11)',
    '--cs-border-subtle': 'rgba(255, 214, 153, 0.09)',
    '--cs-border-faint': 'rgba(255, 214, 153, 0.06)',
    '--cs-border-strong': 'rgba(255, 214, 153, 0.18)',

    '--cs-hover': 'rgba(255, 214, 153, 0.05)',
    '--cs-wash': 'rgba(255, 214, 153, 0.025)',

    '--cs-text': '#E8DAC0',
    '--cs-text-muted': '#B5A483',
    '--cs-text-faint': '#8C7D63',
    '--cs-text-strong': '#F5EBD8',
    '--cs-text-on-accent': '#1A1206',
    '--cs-knob': '#E8DAC0',

    '--cs-accent': '#E99A3C',
    '--cs-accent-hover': '#F2AE5C',
    '--cs-accent-ink': '#E99A3C',
    '--cs-accent-border': 'rgba(233, 154, 60, 0.32)',
    '--cs-accent-wash': 'rgba(233, 154, 60, 0.12)',
    '--cs-accent-text': '#F5C78C',

    '--cs-positive': '#A3C47A',
    '--cs-positive-border': 'rgba(163, 196, 122, 0.30)',
    '--cs-positive-wash': 'rgba(163, 196, 122, 0.08)',
    '--cs-negative': '#E5735C',
    '--cs-negative-border': 'rgba(229, 115, 92, 0.35)',
    '--cs-negative-wash': 'rgba(229, 115, 92, 0.07)',

    '--cs-art-glow': 'rgba(0, 0, 0, 0.6)',

    '--cs-scrim': 'rgba(12, 9, 5, 0.78)',
    '--cs-shadow-modal': '0 25px 50px -12px rgba(0, 0, 0, 0.6)',
    '--cs-shadow-pop': '0 12px 32px -8px rgba(0, 0, 0, 0.55)',
    '--cs-panel-glow': 'none',

    '--wear-fn': '#7FB4C2',
    '--wear-mw': '#9CC48A',
    '--wear-ft': '#CDB88C',
    '--wear-ww': '#D9905E',
    '--wear-bs': '#C9665C',

    '--cs-hold-wallet': '#8FA6C4',
    '--cs-hold-csfloat': '#CDB88C',
    '--cs-hold-inventory': '#A9B882',
    '--cs-hold-listed': '#7DB39A',
    '--cs-hold-unconfirmed': '#B998C6',
    '--cs-hold-hatch': 'rgba(255, 240, 220, 0.45)',

    '--cs-series-1': '#8FA6C4',
    '--cs-series-2': '#7DB39A',
    '--cs-series-3': '#B998C6',
    '--cs-series-4': '#D9905E',
    '--cs-series-5': '#CDB88C',
    '--cs-series-6': '#C9665C',
    '--cs-series-7': '#7FB4C2',
    '--cs-series-8': '#9A948A',

    '--cs-avatar-bg-sl': '24% 22%',
    '--cs-avatar-ring-sl': '28% 36%',
    '--cs-avatar-text-sl': '40% 82%'
  }
};
