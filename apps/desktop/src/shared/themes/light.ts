import type { Theme } from './palette.js';

/**
 * The house theme turned over: the same grey family and the same single amber, on paper.
 *
 * What changes besides the lightness, and why. Borders and overlays are dark ink at a slightly
 * higher alpha than the dark theme's white, because a hairline reads fainter on white. The amber
 * fill stays bright, but anything *drawn* in the accent — an icon, a caret, text on its wash —
 * takes a deeper amber, since #FFB900 on white is under 2:1. Profit, loss and the data ramps are
 * darkened for the same reason; a light surface needs a darker mark to say the same thing.
 */
export const light: Theme = {
  id: 'light',
  label: 'Light',
  description: 'Paper-white panels on soft grey',
  scheme: 'light',
  palette: {
    '--cs-backdrop': '#F2F3F5',
    '--cs-bg': '#F2F3F5',
    '--cs-surface': '#FFFFFF',
    '--cs-surface-raised': '#FFFFFF',
    '--cs-surface-inset': '#F8F9FB',
    '--cs-field': '#FFFFFF',
    '--cs-titlebar-bg': '#F8F9FB',
    '--cs-titlebar-text': '#4B5563',

    '--cs-border': 'rgba(15, 23, 42, 0.13)',
    '--cs-border-subtle': 'rgba(15, 23, 42, 0.10)',
    '--cs-border-faint': 'rgba(15, 23, 42, 0.08)',
    '--cs-border-strong': 'rgba(15, 23, 42, 0.22)',

    '--cs-hover': 'rgba(15, 23, 42, 0.045)',
    '--cs-wash': 'rgba(15, 23, 42, 0.025)',

    '--cs-text': '#1F2937',
    '--cs-text-muted': '#4B5563',
    '--cs-text-faint': '#6B7280',
    '--cs-text-strong': '#111827',
    '--cs-text-on-accent': '#030712',
    '--cs-knob': '#FFFFFF',

    '--cs-accent': '#F2A900',
    '--cs-accent-hover': '#E09C00',
    '--cs-accent-ink': '#A86F00',
    '--cs-accent-border': 'rgba(204, 140, 0, 0.45)',
    '--cs-accent-wash': 'rgba(242, 169, 0, 0.13)',
    '--cs-accent-text': '#8A5A00',

    '--cs-positive': '#047857',
    '--cs-positive-border': 'rgba(4, 120, 87, 0.30)',
    '--cs-positive-wash': 'rgba(4, 120, 87, 0.08)',
    '--cs-negative': '#C81E1E',
    '--cs-negative-border': 'rgba(200, 30, 30, 0.35)',
    '--cs-negative-wash': 'rgba(200, 30, 30, 0.06)',

    // A soft grey halo: skins are drawn for a dark well, and a little shade keeps their pale edges
    // off the white.
    '--cs-art-glow': 'rgba(15, 23, 42, 0.16)',

    '--cs-scrim': 'rgba(15, 23, 42, 0.38)',
    '--cs-shadow-modal': '0 25px 50px -12px rgba(15, 23, 42, 0.28)',
    '--cs-shadow-pop': '0 12px 32px -8px rgba(15, 23, 42, 0.20)',
    '--cs-panel-glow': 'none',

    '--wear-fn': '#0EA5E9',
    '--wear-mw': '#10B981',
    '--wear-ft': '#B39A5E',
    '--wear-ww': '#E07B39',
    '--wear-bs': '#D04E4A',

    '--cs-hold-wallet': '#4C7FE6',
    '--cs-hold-csfloat': '#E07B39',
    '--cs-hold-inventory': '#5E9E58',
    '--cs-hold-listed': '#2F9E8C',
    '--cs-hold-unconfirmed': '#9A6DD6',
    '--cs-hold-hatch': 'rgba(255, 255, 255, 0.55)',

    '--cs-series-1': '#4C7FE6',
    '--cs-series-2': '#2F9E8C',
    '--cs-series-3': '#9A6DD6',
    '--cs-series-4': '#E07B39',
    '--cs-series-5': '#B39A5E',
    '--cs-series-6': '#D04E4A',
    '--cs-series-7': '#0EA5E9',
    '--cs-series-8': '#7A8699',

    '--cs-avatar-bg-sl': '42% 88%',
    '--cs-avatar-ring-sl': '32% 74%',
    '--cs-avatar-text-sl': '38% 32%'
  }
};
