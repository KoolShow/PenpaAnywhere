import { detectPlatform } from './platform';

function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.max(0, Math.min(1, s));
  const ll = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (hh < 60) [r1, g1, b1] = [c, x, 0];
  else if (hh < 120) [r1, g1, b1] = [x, c, 0];
  else if (hh < 180) [r1, g1, b1] = [0, c, x];
  else if (hh < 240) [r1, g1, b1] = [0, x, c];
  else if (hh < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const toHex = (v: number) =>
    Math.round(Math.max(0, Math.min(255, (v + m) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`.toUpperCase();
}

/**
 * Derive a complete MD3 Dark semantic color palette (--md-sys-color-*) from a single
 * OS accent color (e.g. Windows DWM AccentColor or macOS AppleAccentColor).
 */
export function generateMd3DarkTokensFromSeed(seedHex: string): Record<string, string> | null {
  const rgb = hexToRgb(seedHex);
  if (!rgb) return null;
  const [h, rawS] = rgbToHsl(rgb[0], rgb[1], rgb[2]);

  const primaryS = rawS < 0.08 ? 0.06 : Math.max(0.42, Math.min(0.76, rawS));
  const secondaryS = rawS < 0.08 ? 0.05 : Math.min(0.32, primaryS * 0.45);
  const tertiaryH = (h + 60) % 360;
  const tertiaryS = rawS < 0.08 ? 0.12 : Math.min(0.55, primaryS * 0.72);
  const neutralS = rawS < 0.08 ? 0.02 : 0.14;
  const neutralVarS = rawS < 0.08 ? 0.04 : 0.18;

  return {
    '--md-sys-color-primary': hslToHex(h, primaryS, 0.76),
    '--md-sys-color-on-primary': hslToHex(h, primaryS, 0.16),
    '--md-sys-color-primary-container': hslToHex(h, Math.min(0.85, primaryS * 1.05), 0.26),
    '--md-sys-color-on-primary-container': hslToHex(h, primaryS, 0.9),

    '--md-sys-color-secondary': hslToHex(h, secondaryS, 0.78),
    '--md-sys-color-on-secondary': hslToHex(h, secondaryS, 0.18),
    '--md-sys-color-secondary-container': hslToHex(h, secondaryS, 0.27),
    '--md-sys-color-on-secondary-container': hslToHex(h, secondaryS, 0.88),

    '--md-sys-color-tertiary': hslToHex(tertiaryH, tertiaryS, 0.78),
    '--md-sys-color-on-tertiary': hslToHex(tertiaryH, tertiaryS, 0.17),
    '--md-sys-color-tertiary-container': hslToHex(tertiaryH, tertiaryS, 0.26),
    '--md-sys-color-on-tertiary-container': hslToHex(tertiaryH, tertiaryS, 0.9),

    '--md-sys-color-background': hslToHex(h, neutralS, 0.07),
    '--md-sys-color-on-background': hslToHex(h, neutralS * 0.6, 0.9),
    '--md-sys-color-surface': hslToHex(h, neutralS, 0.07),
    '--md-sys-color-on-surface': hslToHex(h, neutralS * 0.6, 0.9),
    '--md-sys-color-surface-variant': hslToHex(h, neutralVarS, 0.27),
    '--md-sys-color-on-surface-variant': hslToHex(h, neutralVarS, 0.78),
    '--md-sys-color-surface-bright': hslToHex(h, neutralS, 0.22),
    '--md-sys-color-surface-dim': hslToHex(h, neutralS, 0.06),

    '--md-sys-color-surface-container-low': hslToHex(h, neutralS, 0.1),
    '--md-sys-color-surface-container': hslToHex(h, neutralS, 0.12),
    '--md-sys-color-surface-container-high': hslToHex(h, neutralS, 0.16),
    '--md-sys-color-surface-container-highest': hslToHex(h, neutralS, 0.2),

    '--md-sys-color-outline': hslToHex(h, neutralVarS, 0.56),
    '--md-sys-color-outline-variant': hslToHex(h, neutralVarS, 0.28),
    '--md-sys-color-inverse-surface': hslToHex(h, neutralS * 0.6, 0.9),
    '--md-sys-color-inverse-on-surface': hslToHex(h, neutralS, 0.18),
    '--md-sys-color-inverse-primary': hslToHex(h, primaryS, 0.36),
    '--md-sys-color-surface-tint': hslToHex(h, primaryS, 0.76),

    '--md-sys-color-primary-fixed': hslToHex(h, primaryS, 0.9),
    '--md-sys-color-primary-fixed-dim': hslToHex(h, primaryS, 0.76),
    '--md-sys-color-on-primary-fixed': hslToHex(h, primaryS, 0.12),
    '--md-sys-color-on-primary-fixed-variant': hslToHex(h, primaryS, 0.28),

    '--md-sys-color-secondary-fixed': hslToHex(h, secondaryS, 0.9),
    '--md-sys-color-secondary-fixed-dim': hslToHex(h, secondaryS, 0.78),
    '--md-sys-color-on-secondary-fixed': hslToHex(h, secondaryS, 0.12),
    '--md-sys-color-on-secondary-fixed-variant': hslToHex(h, secondaryS, 0.28),

    '--md-sys-color-tertiary-fixed': hslToHex(tertiaryH, tertiaryS, 0.9),
    '--md-sys-color-tertiary-fixed-dim': hslToHex(tertiaryH, tertiaryS, 0.78),
    '--md-sys-color-on-tertiary-fixed': hslToHex(tertiaryH, tertiaryS, 0.12),
    '--md-sys-color-on-tertiary-fixed-variant': hslToHex(tertiaryH, tertiaryS, 0.28),
  };
}

const MD3_TOKEN_NAMES = [
  '--md-sys-color-primary',
  '--md-sys-color-on-primary',
  '--md-sys-color-primary-container',
  '--md-sys-color-on-primary-container',
  '--md-sys-color-secondary',
  '--md-sys-color-on-secondary',
  '--md-sys-color-secondary-container',
  '--md-sys-color-on-secondary-container',
  '--md-sys-color-tertiary',
  '--md-sys-color-on-tertiary',
  '--md-sys-color-tertiary-container',
  '--md-sys-color-on-tertiary-container',
  '--md-sys-color-error',
  '--md-sys-color-on-error',
  '--md-sys-color-error-container',
  '--md-sys-color-on-error-container',
  '--md-sys-color-background',
  '--md-sys-color-on-background',
  '--md-sys-color-surface',
  '--md-sys-color-on-surface',
  '--md-sys-color-surface-variant',
  '--md-sys-color-on-surface-variant',
  '--md-sys-color-surface-bright',
  '--md-sys-color-surface-dim',
  '--md-sys-color-surface-container-low',
  '--md-sys-color-surface-container',
  '--md-sys-color-surface-container-high',
  '--md-sys-color-surface-container-highest',
  '--md-sys-color-outline',
  '--md-sys-color-outline-variant',
  '--md-sys-color-inverse-surface',
  '--md-sys-color-inverse-on-surface',
  '--md-sys-color-inverse-primary',
  '--md-sys-color-surface-tint',
  '--md-sys-color-shadow',
  '--md-sys-color-scrim',
  '--md-sys-color-primary-fixed',
  '--md-sys-color-primary-fixed-dim',
  '--md-sys-color-on-primary-fixed',
  '--md-sys-color-on-primary-fixed-variant',
  '--md-sys-color-secondary-fixed',
  '--md-sys-color-secondary-fixed-dim',
  '--md-sys-color-on-secondary-fixed',
  '--md-sys-color-on-secondary-fixed-variant',
  '--md-sys-color-tertiary-fixed',
  '--md-sys-color-tertiary-fixed-dim',
  '--md-sys-color-on-tertiary-fixed',
  '--md-sys-color-on-tertiary-fixed-variant',
] as const;

export function getCurrentMd3Tokens(): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof window === 'undefined' || typeof document === 'undefined') return result;
  const computed = window.getComputedStyle(document.documentElement);
  for (const name of MD3_TOKEN_NAMES) {
    const val = computed.getPropertyValue(name).trim();
    if (val) result[name] = val;
  }
  return result;
}

/**
 * Apply Material Design 3 dynamic color tokens directly onto :root CSS custom properties.
 */
export function applyMd3Tokens(raw: Record<string, string> | string | null | undefined): boolean {
  if (!raw || typeof document === 'undefined') return false;
  let map: Record<string, string>;
  if (typeof raw === 'string') {
    try {
      map = JSON.parse(raw) as Record<string, string>;
    } catch {
      return false;
    }
  } else {
    map = raw;
  }

  const rootStyle = document.documentElement.style;
  let applied = 0;
  for (const [key, val] of Object.entries(map)) {
    if (key.startsWith('--md-sys-color-') && typeof val === 'string' && val.length > 0) {
      rootStyle.setProperty(key, val);
      applied++;
    }
  }
  if (applied > 0 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('penpaanywhere-md3-updated'));
  }
  return applied > 0;
}

export function applyAccentSeed(seedHex: string | null | undefined): boolean {
  if (!seedHex) return false;
  const tokens = generateMd3DarkTokensFromSeed(seedHex);
  return applyMd3Tokens(tokens);
}

export function initDynamicThemeBridge(): void {
  if (typeof window === 'undefined') return;

  window.__PENPAANYWHERE_APPLY_MD3_TOKENS__ = (tokens) => {
    applyMd3Tokens(tokens);
  };

  // 1. Android: synchronous Material You dynamic color bridge
  try {
    const raw = window.AndroidOverlay?.getDynamicColorTokens?.();
    if (raw) {
      applyMd3Tokens(raw);
      return;
    }
  } catch (err) {
    console.warn('[PenpaAnywhere] Failed to load Android dynamic colors:', err);
  }

  // 2. Windows / macOS (Tauri 2): read OS accent color & listen for live changes
  if (detectPlatform() === 'tauri') {
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const accent = await invoke<string | null>('get_system_accent_color');
        if (accent) {
          applyAccentSeed(accent);
        }
        const { listen } = await import('@tauri-apps/api/event');
        await listen<string>('system-accent-changed', (ev) => {
          applyAccentSeed(ev.payload);
        });
      } catch (err) {
        console.warn('[PenpaAnywhere] Failed to load Tauri system accent color:', err);
      }
    })();
  }
}
