/**
 * The palette contract: every colour the window draws, named by the job it does.
 *
 * A theme is one `Palette` — a value for each token below — and nothing else. Components never
 * name a colour; `app.css` reads these tokens, so a theme recolours every screen without touching
 * a stylesheet. The keys are the CSS custom properties themselves, so searching for
 * `--cs-surface-inset` finds its value in every theme and every rule that paints with it.
 *
 * Adding a token is three edits, and the compiler and `theme-palettes.test.ts` refuse anything less:
 * the name here, a value in every theme, and the rule in `app.css` that uses it. A token is a
 * *role* ("the ink of an accent mark"), not a hue ("dark amber"): two roles that happen to share a
 * value in one theme stay two tokens, because another theme will want them apart. That is why
 * `--cs-accent` (a fill) and `--cs-accent-ink` (an icon drawn in the accent) both exist although
 * they are the same amber on the dark theme.
 *
 * What is not here: radii, type, motion and layout, which no theme changes (`renderer/tokens.css`),
 * and the QR code's quiet zone, which must be white whatever the theme.
 */
export const PALETTE_TOKENS = [
  // Surfaces, from the window outwards. `--cs-backdrop` is the one token that may be any CSS
  // background — a gradient or a layered image — because it is only ever a `background`; every
  // other surface is a solid colour.
  '--cs-backdrop',
  '--cs-bg',
  '--cs-surface',
  '--cs-surface-raised',
  '--cs-surface-inset',
  '--cs-field',
  '--cs-titlebar-bg',
  '--cs-titlebar-text',

  // Borders: the primary separator, by a wide margin.
  '--cs-border',
  '--cs-border-subtle',
  '--cs-border-faint',
  '--cs-border-strong',

  // Overlays laid over a surface on hover, and a resting wash.
  '--cs-hover',
  '--cs-wash',

  // Text ramp: strong is rare, reserved for the one number that matters.
  '--cs-text',
  '--cs-text-muted',
  '--cs-text-faint',
  '--cs-text-strong',
  '--cs-text-on-accent',
  '--cs-knob',

  // Accent: the only saturated hue in the chrome. A fill, its hover, an icon or rule drawn in it,
  // and text set on its wash.
  '--cs-accent',
  '--cs-accent-hover',
  '--cs-accent-ink',
  '--cs-accent-border',
  '--cs-accent-wash',
  '--cs-accent-text',

  // Profit and loss, and the connection and failure surfaces that borrow them.
  '--cs-positive',
  '--cs-positive-border',
  '--cs-positive-wash',
  '--cs-negative',
  '--cs-negative-border',
  '--cs-negative-wash',

  // Item art: the centre of the round halo a skin sits on in a tile's well.
  '--cs-art-glow',

  // What sits under a modal, and the shadows: modals and popovers cast one. A panel casts nothing in
  // the house themes (`none`); a theme that wants its panels to glow sets a box-shadow here.
  '--cs-scrim',
  '--cs-shadow-modal',
  '--cs-shadow-pop',
  '--cs-panel-glow',

  // Wear is data, not chrome: never draw it in the accent, never colour a control with it.
  '--wear-fn',
  '--wear-mw',
  '--wear-ft',
  '--wear-ww',
  '--wear-bs',

  // Holdings segments, also data: one hue per bucket a venue names a figure for, the CSFloat
  // balance's apart from the Steam wallet's, one for the inventory's appraisal, and the hatch drawn
  // over a not-yet-cleared part. Never `--cs-positive`: none of these figures is a profit.
  '--cs-hold-wallet',
  '--cs-hold-csfloat',
  '--cs-hold-inventory',
  '--cs-hold-listed',
  '--cs-hold-unconfirmed',
  '--cs-hold-hatch',

  // Categorical series, for a chart that needs one hue per slice: eight, distinct at a glance
  // against the theme's surfaces, in the theme's own register, and none of them the accent.
  '--cs-series-1',
  '--cs-series-2',
  '--cs-series-3',
  '--cs-series-4',
  '--cs-series-5',
  '--cs-series-6',
  '--cs-series-7',
  '--cs-series-8',

  // Account avatars. Each account's hue is chosen from its name (`--avatar-hue`, set by the
  // component); a theme sets only the saturation and lightness, as `S% L%`, which is what keeps
  // every avatar inside one muted band.
  '--cs-avatar-bg-sl',
  '--cs-avatar-ring-sl',
  '--cs-avatar-text-sl'
] as const;

export type PaletteToken = typeof PALETTE_TOKENS[number];

/** A value for every token. A missing or misspelt one is a type error in the theme file. */
export type Palette = Readonly<Record<PaletteToken, string>>;

export type Theme = {
  /** Stored in `settings.json`; never rename one that has shipped. */
  readonly id: string;
  /** What Settings calls it. */
  readonly label: string;
  /** One line under the label in Settings. */
  readonly description: string;
  /**
   * Which way the native parts lean — scrollbars, a `<select>`'s list, Windows' caption buttons —
   * and which half of "Match Windows" this theme can stand for.
   */
  readonly scheme: 'dark' | 'light';
  readonly palette: Palette;
};
