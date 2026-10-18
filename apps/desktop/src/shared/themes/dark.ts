import type { Theme } from './palette.js';

/**
 * The house theme, and the default: near-black, low-chroma, flat; hairline white borders at 6–10%
 * rather than shadows; a four-step grey text ramp that is muted by default; exactly one accent,
 * amber, used sparingly. The failure mode to avoid is a *blue* dark theme
 * (`cslytics-app-docs/style-guide.md`).
 */
export const dark: Theme = {
  id: 'dark',
  label: 'Dark',
  description: 'Near-black, with one amber accent',
  scheme: 'dark',
  palette: {
    '--cs-backdrop': '#0B0F14',
    '--cs-bg': '#0B0F14',
    '--cs-surface': '#111827',
    '--cs-surface-raised': '#0F172A',
    '--cs-surface-inset': '#0F1722',
    '--cs-field': '#0B0F14',
    '--cs-titlebar-bg': '#0F1722',
    '--cs-titlebar-text': '#99A1AF',

    '--cs-border': 'rgba(255, 255, 255, 0.10)',
    '--cs-border-subtle': 'rgba(255, 255, 255, 0.08)',
    '--cs-border-faint': 'rgba(255, 255, 255, 0.06)',
    '--cs-border-strong': 'rgba(255, 255, 255, 0.16)',

    '--cs-hover': 'rgba(255, 255, 255, 0.05)',
    '--cs-wash': 'rgba(255, 255, 255, 0.02)',

    '--cs-text': '#E5E7EB',
    '--cs-text-muted': '#99A1AF',
    '--cs-text-faint': '#6A7282',
    '--cs-text-strong': '#F3F4F6',
    '--cs-text-on-accent': '#030712',
    '--cs-knob': '#E5E7EB',

    '--cs-accent': '#FFB900',
    '--cs-accent-hover': '#FFD230',
    '--cs-accent-ink': '#FFB900',
    '--cs-accent-border': 'rgba(255, 185, 0, 0.30)',
    '--cs-accent-wash': 'rgba(255, 185, 0, 0.10)',
    '--cs-accent-text': '#FEE685',

    '--cs-positive': '#00D492',
    '--cs-positive-border': 'rgba(0, 212, 146, 0.30)',
    '--cs-positive-wash': 'rgba(0, 212, 146, 0.08)',
    '--cs-negative': '#FF6467',
    '--cs-negative-border': 'rgba(255, 100, 103, 0.35)',
    '--cs-negative-wash': 'rgba(255, 100, 103, 0.07)',

    // Black, so it separates the skin from the well without adding a colour to the chrome.
    '--cs-art-glow': 'rgba(0, 0, 0, 0.7)',

    '--cs-scrim': 'rgba(7, 10, 15, 0.78)',
    '--cs-shadow-modal': '0 25px 50px -12px rgba(0, 0, 0, 0.55)',
    '--cs-shadow-pop': '0 12px 32px -8px rgba(0, 0, 0, 0.5)',
    '--cs-panel-glow': 'none',

    // Field-Tested is nudged away from the guide's #dcb259, which reads as "selected UI" next to amber.
    '--wear-fn': '#4CC2FF',
    '--wear-mw': '#6FE7B7',
    '--wear-ft': '#C8B78E',
    '--wear-ww': '#E08D5B',
    '--wear-bs': '#D2635F',

    '--cs-hold-wallet': '#6E9BF0',
    '--cs-hold-csfloat': '#E08D5B',
    '--cs-hold-inventory': '#8FB889',
    '--cs-hold-listed': '#4FB6A5',
    '--cs-hold-unconfirmed': '#B48CE0',
    '--cs-hold-hatch': 'rgba(255, 255, 255, 0.5)',

    '--cs-series-1': '#6E9BF0',
    '--cs-series-2': '#4FB6A5',
    '--cs-series-3': '#B48CE0',
    '--cs-series-4': '#E08D5B',
    '--cs-series-5': '#C8B78E',
    '--cs-series-6': '#D2635F',
    '--cs-series-7': '#4CC2FF',
    '--cs-series-8': '#8E97A8',

    '--cs-avatar-bg-sl': '26% 24%',
    '--cs-avatar-ring-sl': '30% 38%',
    '--cs-avatar-text-sl': '45% 84%'
  }
};
