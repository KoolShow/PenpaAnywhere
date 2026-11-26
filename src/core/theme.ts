import { computed, ref } from 'vue';
import {
  detectPlatform,
  setOsWindowTheme,
  supportsOsDynamicColor,
  type AndroidThemeBundle,
} from './platform';
import { loadPersistedState, patchPersistedState, type ThemeMode } from './storage';

export type ResolvedColorScheme = 'dark' | 'light';

const DEFAULT_SEED_HEX = '#4C8DF6';
const DEFAULT_HUE = 217;

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

export function hslToHex(h: number, s: number, l: number): string {
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

export function hueToSeedHex(hue: number): string {
  return hslToHex(hue, 0.72, 0.56);
}

/**
 * Derive a complete MD3 Dark or Light semantic color palette (--md-sys-color-*) from a single seed hex.
 */
export function generateMd3TokensFromSeed(
  seedHex: string,
  scheme: ResolvedColorScheme = 'dark',
): Record<string, string> | null {
  const rgb = hexToRgb(seedHex);
  if (!rgb) return null;
  const [h, rawS] = rgbToHsl(rgb[0], rgb[1], rgb[2]);

  const isMono = rawS < 0.08;
  const primaryS = isMono ? 0.06 : Math.max(0.42, Math.min(0.76, rawS));
  const secondaryS = isMono ? 0.05 : Math.min(0.32, primaryS * 0.45);
  const tertiaryH = (h + 60) % 360;
  const tertiaryS = isMono ? 0.12 : Math.min(0.55, primaryS * 0.72);
  const neutralS = isMono ? 0.02 : 0.14;
  const neutralVarS = isMono ? 0.04 : 0.18;

  if (scheme === 'light') {
    const pLightS = isMono ? 0.06 : Math.max(0.46, Math.min(0.78, rawS));
    const secLightS = isMono ? 0.05 : Math.min(0.34, pLightS * 0.48);
    const tertLightS = isMono ? 0.12 : Math.min(0.54, pLightS * 0.7);
    const nLightS = isMono ? 0.02 : 0.12;
    const nvLightS = isMono ? 0.04 : 0.16;

    return {
      '--md-sys-color-primary': hslToHex(h, pLightS, 0.39),
      '--md-sys-color-on-primary': '#FFFFFF',
      '--md-sys-color-primary-container': hslToHex(h, Math.min(0.85, pLightS * 1.05), 0.9),
      '--md-sys-color-on-primary-container': hslToHex(h, pLightS, 0.15),

      '--md-sys-color-secondary': hslToHex(h, secLightS, 0.4),
      '--md-sys-color-on-secondary': '#FFFFFF',
      '--md-sys-color-secondary-container': hslToHex(h, secLightS, 0.9),
      '--md-sys-color-on-secondary-container': hslToHex(h, secLightS, 0.16),

      '--md-sys-color-tertiary': hslToHex(tertiaryH, tertLightS, 0.38),
      '--md-sys-color-on-tertiary': '#FFFFFF',
      '--md-sys-color-tertiary-container': hslToHex(tertiaryH, tertLightS, 0.9),
      '--md-sys-color-on-tertiary-container': hslToHex(tertiaryH, tertLightS, 0.15),

      '--md-sys-color-error': '#B3261E',
      '--md-sys-color-on-error': '#FFFFFF',
      '--md-sys-color-error-container': '#F9DEDC',
      '--md-sys-color-on-error-container': '#410E0B',

      '--md-sys-color-background': hslToHex(h, nLightS, 0.98),
      '--md-sys-color-on-background': hslToHex(h, nLightS, 0.11),
      '--md-sys-color-surface': hslToHex(h, nLightS, 0.98),
      '--md-sys-color-on-surface': hslToHex(h, nLightS, 0.11),
      '--md-sys-color-surface-variant': hslToHex(h, nvLightS, 0.89),
      '--md-sys-color-on-surface-variant': hslToHex(h, nvLightS, 0.29),
      '--md-sys-color-surface-bright': '#FFFFFF',
      '--md-sys-color-surface-dim': hslToHex(h, nLightS, 0.87),

      '--md-sys-color-surface-container-low': hslToHex(h, nLightS, 0.96),
      '--md-sys-color-surface-container': hslToHex(h, nLightS, 0.94),
      '--md-sys-color-surface-container-high': hslToHex(h, nLightS, 0.91),
      '--md-sys-color-surface-container-highest': hslToHex(h, nLightS, 0.87),

      '--md-sys-color-outline': hslToHex(h, nvLightS, 0.46),
      '--md-sys-color-outline-variant': hslToHex(h, nvLightS, 0.77),
      '--md-sys-color-inverse-surface': hslToHex(h, nLightS, 0.19),
      '--md-sys-color-inverse-on-surface': hslToHex(h, nLightS, 0.95),
      '--md-sys-color-inverse-primary': hslToHex(h, pLightS, 0.78),
      '--md-sys-color-surface-tint': hslToHex(h, pLightS, 0.39),
      '--md-sys-color-shadow': '#000000',
      '--md-sys-color-scrim': '#000000',

      '--md-sys-color-primary-fixed': hslToHex(h, pLightS, 0.9),
      '--md-sys-color-primary-fixed-dim': hslToHex(h, pLightS, 0.76),
      '--md-sys-color-on-primary-fixed': hslToHex(h, pLightS, 0.12),
      '--md-sys-color-on-primary-fixed-variant': hslToHex(h, pLightS, 0.28),

      '--md-sys-color-secondary-fixed': hslToHex(h, secLightS, 0.9),
      '--md-sys-color-secondary-fixed-dim': hslToHex(h, secLightS, 0.78),
      '--md-sys-color-on-secondary-fixed': hslToHex(h, secLightS, 0.12),
      '--md-sys-color-on-secondary-fixed-variant': hslToHex(h, secLightS, 0.28),

      '--md-sys-color-tertiary-fixed': hslToHex(tertiaryH, tertLightS, 0.9),
      '--md-sys-color-tertiary-fixed-dim': hslToHex(tertiaryH, tertLightS, 0.78),
      '--md-sys-color-on-tertiary-fixed': hslToHex(tertiaryH, tertLightS, 0.12),
      '--md-sys-color-on-tertiary-fixed-variant': hslToHex(tertiaryH, tertLightS, 0.28),
    };
  }

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

    '--md-sys-color-error': '#F2B8B5',
    '--md-sys-color-on-error': '#601410',
    '--md-sys-color-error-container': '#8C1D18',
    '--md-sys-color-on-error-container': '#F9DEDC',

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
    '--md-sys-color-shadow': '#000000',
    '--md-sys-color-scrim': '#000000',

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

export function generateMd3DarkTokensFromSeed(seedHex: string): Record<string, string> | null {
  return generateMd3TokensFromSeed(seedHex, 'dark');
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
  const computedStyle = window.getComputedStyle(document.documentElement);
  for (const name of MD3_TOKEN_NAMES) {
    const val = computedStyle.getPropertyValue(name).trim();
    if (val) result[name] = val;
  }
  return result;
}

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

// Reactive theme state
const saved = loadPersistedState();
const initialPlatform = detectPlatform();
const osDynamicSupported = ref(supportsOsDynamicColor(initialPlatform));

function detectBrowserPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export const themeMode = ref<ThemeMode>(
  saved.themeMode === 'light' || saved.themeMode === 'dark' || saved.themeMode === 'auto'
    ? saved.themeMode
    : 'auto',
);
export const dynamicColorEnabled = ref<boolean>(
  typeof saved.dynamicColor === 'boolean' ? saved.dynamicColor : osDynamicSupported.value,
);
export const customHue = ref<number>(
  typeof saved.customHue === 'number' && Number.isFinite(saved.customHue)
    ? ((saved.customHue % 360) + 360) % 360
    : DEFAULT_HUE,
);
export const dynamicColorSupported = computed(() => osDynamicSupported.value);

const systemPrefersDark = ref<boolean>(detectBrowserPrefersDark());
let osAccentHex: string | null = null;
let androidThemeBundle: AndroidThemeBundle | null = null;
let legacyAndroidDarkTokens: Record<string, string> | null = null;

export const resolvedColorScheme = computed<ResolvedColorScheme>(() => {
  if (themeMode.value === 'light') return 'light';
  if (themeMode.value === 'dark') return 'dark';
  return systemPrefersDark.value ? 'dark' : 'light';
});

export function recomputeAndApplyTheme(): void {
  const scheme = resolvedColorScheme.value;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.colorScheme = scheme;
    document.documentElement.style.colorScheme = scheme;
  }

  let tokens: Record<string, string> | null = null;
  if (dynamicColorEnabled.value && osDynamicSupported.value) {
    if (androidThemeBundle) {
      tokens = scheme === 'light' ? androidThemeBundle.light : androidThemeBundle.dark;
    } else if (legacyAndroidDarkTokens && scheme === 'dark') {
      tokens = legacyAndroidDarkTokens;
    } else if (osAccentHex) {
      tokens = generateMd3TokensFromSeed(osAccentHex, scheme);
    } else {
      tokens = generateMd3TokensFromSeed(DEFAULT_SEED_HEX, scheme);
    }
  } else {
    tokens = generateMd3TokensFromSeed(hueToSeedHex(customHue.value), scheme);
  }

  if (tokens) {
    applyMd3Tokens(tokens);
  }
  void setOsWindowTheme(scheme === 'dark');
}

export function setThemeMode(mode: ThemeMode): void {
  if (themeMode.value === mode) return;
  themeMode.value = mode;
  patchPersistedState({ themeMode: mode });
  recomputeAndApplyTheme();
}

export function setDynamicColorEnabled(enabled: boolean): void {
  if (!osDynamicSupported.value && enabled) return;
  if (dynamicColorEnabled.value === enabled) return;
  dynamicColorEnabled.value = enabled;
  patchPersistedState({ dynamicColor: enabled });
  recomputeAndApplyTheme();
}

export function setCustomHue(hue: number): void {
  const normalized = ((Math.round(hue) % 360) + 360) % 360;
  customHue.value = normalized;
  patchPersistedState({ customHue: normalized });
  if (!dynamicColorEnabled.value || !osDynamicSupported.value) {
    recomputeAndApplyTheme();
  }
}

function ingestAndroidBundle(raw: AndroidThemeBundle | string | null | undefined): boolean {
  if (!raw) return false;
  let parsed: AndroidThemeBundle;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as AndroidThemeBundle;
    } catch {
      return false;
    }
  } else {
    parsed = raw;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.dark || !parsed.light) return false;
  androidThemeBundle = parsed;
  if (typeof parsed.systemDark === 'boolean') {
    systemPrefersDark.value = parsed.systemDark;
  }
  if (typeof parsed.available === 'boolean') {
    osDynamicSupported.value = parsed.available;
    if (!parsed.available && saved.dynamicColor === undefined) {
      dynamicColorEnabled.value = false;
    }
  }
  recomputeAndApplyTheme();
  return true;
}

export function initDynamicThemeBridge(): void {
  if (typeof window === 'undefined') return;

  // Listen to browser / OS prefers-color-scheme changes
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    systemPrefersDark.value = mq.matches;
    const onSchemeChange = (ev: MediaQueryListEvent) => {
      systemPrefersDark.value = ev.matches;
      if (themeMode.value === 'auto') {
        recomputeAndApplyTheme();
      }
    };
    mq.addEventListener?.('change', onSchemeChange);
  }

  window.__PENPAANYWHERE_APPLY_ANDROID_THEME_BUNDLE__ = (bundle) => {
    ingestAndroidBundle(bundle);
  };

  window.__PENPAANYWHERE_APPLY_MD3_TOKENS__ = (tokens) => {
    if (typeof tokens === 'string') {
      try {
        legacyAndroidDarkTokens = JSON.parse(tokens) as Record<string, string>;
      } catch {
        return;
      }
    } else if (tokens && typeof tokens === 'object') {
      legacyAndroidDarkTokens = tokens;
    }
    recomputeAndApplyTheme();
  };

  // 1. Android: synchronous Material You dual light/dark color bundle
  try {
    const bundleRaw = window.AndroidOverlay?.getDynamicColorBundle?.();
    if (bundleRaw && ingestAndroidBundle(bundleRaw)) {
      return;
    }
    const raw = window.AndroidOverlay?.getDynamicColorTokens?.();
    if (raw) {
      legacyAndroidDarkTokens = JSON.parse(raw) as Record<string, string>;
      recomputeAndApplyTheme();
      return;
    }
  } catch (err) {
    console.warn('[PenpaAnywhere] Failed to load Android dynamic colors:', err);
  }

  // Apply initial theme immediately before async Tauri call resolves
  recomputeAndApplyTheme();

  // 2. Windows / macOS (Tauri 2): read OS accent color & listen for live changes
  if (detectPlatform() === 'tauri') {
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const accent = await invoke<string | null>('get_system_accent_color');
        osAccentHex = accent && accent.trim() ? accent : null;
        recomputeAndApplyTheme();
        const { listen } = await import('@tauri-apps/api/event');
        await listen<string | null>('system-accent-changed', (ev) => {
          osAccentHex = ev.payload && ev.payload.trim() ? ev.payload : null;
          recomputeAndApplyTheme();
        });
      } catch (err) {
        console.warn('[PenpaAnywhere] Failed to load Tauri system accent color:', err);
      }
    })();
  }
}
