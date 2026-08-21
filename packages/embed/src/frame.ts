import { defineGnomonCalendar } from './component.js';

/**
 * The iframe fallback's page script (phase 4.7).
 *
 * Served by Gnomon at `/embed/frame` and loaded inside an iframe by the
 * loader when the inline path is refused -- typically by a host CSP that
 * will not load our component into their document.
 *
 * THE TOKEN NEVER APPEARS IN THE URL. It would end up in the host's referrer
 * logs, in this frame's own history, and in any analytics recording document
 * URLs. Instead the loader mints it on the HOST's origin -- where the
 * session cookie lives -- and posts it in. This script announces readiness,
 * waits, and only then renders.
 */

defineGnomonCalendar();

interface FrameConfig {
  calendars: string;
  view: string;
  date: string;
  tz: string;
  locale: string;
}

function readConfig(): FrameConfig {
  const params = new URLSearchParams(location.search);
  const get = (name: string) => params.get(name) ?? '';
  return {
    calendars: get('calendars'),
    view: get('view') || 'month',
    date: get('date'),
    tz: get('tz'),
    locale: get('locale'),
  };
}

function render(token: string): void {
  const config = readConfig();
  const element = document.createElement('gnomon-calendar');

  // The API is this frame's own origin, because Gnomon served this page.
  element.setAttribute('api', location.origin);
  element.setAttribute('token', token);
  for (const [name, value] of Object.entries(config)) {
    if (value) element.setAttribute(name === 'calendars' ? 'calendars' : name, value);
  }
  element.style.display = 'block';
  element.style.height = '100%';

  const root = document.querySelector('#root');
  if (!root) return;
  root.replaceChildren(element);
}

function showMessage(text: string): void {
  const root = document.querySelector('#root');
  if (root) root.textContent = text;
}

/**
 * The host page is the only party allowed to hand us a token.
 *
 * `event.source !== parent` rejects messages from anywhere but our embedder,
 * which matters because any page can postMessage into a frame. The ancestor
 * origin is not checkable from here without `document.referrer` heuristics,
 * so the trust boundary is deliberately narrow: this frame renders whatever
 * token its embedder gives it, and the token itself is scoped by Gnomon
 * (ADR-0009) rather than by us guessing who is embedding.
 */
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return;

  const data = event.data as { type?: string; token?: string } | null;
  if (data?.type !== 'gnomon:token' || typeof data.token !== 'string') return;

  render(data.token);
});

// Announced after the listener is attached, so a parent that replies
// synchronously is not missed.
window.parent?.postMessage({ type: 'gnomon:ready' }, '*');

// If no token arrives, say so rather than showing an empty rectangle for
// ever. A silent blank frame is the least debuggable possible failure.
setTimeout(() => {
  if (!document.querySelector('gnomon-calendar')) {
    showMessage('Waiting for the host page to provide a calendar token.');
  }
}, 5_000);
