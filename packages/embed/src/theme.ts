/**
 * Theme tokens (phase 4.6).
 *
 * CSS custom properties, because they are the one styling mechanism that
 * pierces a Shadow DOM boundary from outside. That is the whole point: the
 * host portal must be able to theme the calendar without us dropping the
 * encapsulation that protects it from their stylesheet.
 *
 * No Tailwind, no CSS-in-JS. We cannot assume the host has a build pipeline,
 * and this is the surface they edit by hand.
 */

export interface ThemeTokens {
  /** Text and surfaces. */
  fontFamily?: string;
  fontSize?: string;
  textColour?: string;
  mutedTextColour?: string;
  surfaceColour?: string;
  borderColour?: string;

  /** Event chips. */
  accentColour?: string;
  accentTextColour?: string;

  /** State. */
  todayColour?: string;
  focusColour?: string;

  /** Layout. */
  radius?: string;
  gap?: string;
}

/** `borderColour` -> `--gnomon-border-colour` */
export function tokenToCustomProperty(token: keyof ThemeTokens): string {
  return `--gnomon-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Defaults chosen to be legible rather than opinionated.
 *
 * `accentColour` against `accentTextColour` clears WCAG AA at normal text
 * size; phase 7.1 asserts that, and the theming documentation has to tell
 * integrators the requirement carries over to anything they override, because
 * we cannot check their values at runtime.
 */
export const DEFAULT_THEME: Required<ThemeTokens> = {
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  fontSize: '14px',
  textColour: '#1a1a1a',
  mutedTextColour: '#6b6b6b',
  surfaceColour: '#ffffff',
  borderColour: '#d8d8d8',
  accentColour: '#1f5c8b',
  accentTextColour: '#ffffff',
  todayColour: '#eef4f9',
  focusColour: '#1f5c8b',
  radius: '4px',
  gap: '2px',
};

/**
 * Renders tokens as a `:host` rule.
 *
 * Only the tokens actually supplied are emitted, so an unset token falls
 * through to whatever the host page defined -- which is what lets an
 * integrator theme with a single `--gnomon-accent-colour` on a wrapper
 * element rather than restating the whole set.
 */
export function themeToCss(tokens: ThemeTokens): string {
  const declarations = Object.entries(tokens)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([token, value]) => `  ${tokenToCustomProperty(token as keyof ThemeTokens)}: ${value};`)
    .join('\n');

  return declarations ? `:host {\n${declarations}\n}` : '';
}

/**
 * The fallback layer, applied inside the Shadow DOM.
 *
 * Every token gets a default here rather than in `themeToCss`, so the
 * cascade is: host page value, else explicitly-set token, else this. An
 * integrator who sets nothing still gets a working calendar.
 */
export function defaultThemeCss(): string {
  const declarations = Object.entries(DEFAULT_THEME)
    .map(([token, value]) => {
      const property = tokenToCustomProperty(token as keyof ThemeTokens);
      return `  ${property}: var(${property}, ${value});`;
    })
    .join('\n');

  return `:host {\n${declarations}\n}`;
}
