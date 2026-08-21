/**
 * The <script> tag payload (phase 4.5).
 *
 * This is the file every integrator pastes into their portal, and some of
 * them will read all of it before doing so. It must be auditable in one
 * sitting. That constraint outranks cleverness, and it is why there are no
 * dependencies, no framework, and no abstraction that exists only to be
 * general.
 *
 *   <script src="https://gnomon.example.com/embed.js"
 *           data-gnomon-api="https://gnomon.example.com"
 *           data-gnomon-token-endpoint="/api/gnomon-token"
 *           data-gnomon-calendars="cal-1,cal-2"
 *           data-gnomon-target="#calendar"
 *           defer></script>
 *
 * It does four things: read its own configuration, find where to render,
 * load the component, and fall back to an iframe if that fails.
 */

interface Config {
  api: string;
  tokenEndpoint: string;
  token: string;
  calendars: string;
  view: string;
  date: string;
  tz: string;
  locale: string;
  target: string;
  mode: 'auto' | 'inline' | 'iframe';
  height: string;
}

const PREFIX = 'gnomon';

/**
 * `document.currentScript` is correct while the script is executing, which
 * covers the classic and `defer` cases. It is null inside a module or when
 * the script was injected asynchronously, so fall back to locating our own
 * tag by src.
 */
function ownScript(): HTMLScriptElement | null {
  const current = document.currentScript as HTMLScriptElement | null;
  if (current) return current;

  // noUncheckedIndexedAccess makes the last element possibly-undefined, and
  // it genuinely is when the selector matches nothing.
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[data-gnomon-api]');
  return scripts[scripts.length - 1] ?? null;
}

function readConfig(script: HTMLScriptElement): Config {
  const read = (name: string) => script.dataset[`${PREFIX}${name}`] ?? '';

  const mode = read('Mode');
  return {
    // Default the API to wherever this script came from, which is right in
    // every deployment we ship and saves the integrator one attribute.
    api: read('Api') || new URL(script.src, location.href).origin,
    tokenEndpoint: read('TokenEndpoint'),
    token: read('Token'),
    calendars: read('Calendars'),
    view: read('View') || 'month',
    date: read('Date'),
    tz: read('Tz'),
    locale: read('Locale'),
    target: read('Target'),
    mode: mode === 'inline' || mode === 'iframe' ? mode : 'auto',
    height: read('Height') || '640px',
  };
}

/**
 * Where to render.
 *
 * An explicit `data-gnomon-target` selector wins. Otherwise we insert a
 * container immediately after our own script tag, so that the calendar
 * appears where the integrator put the snippet -- which is what they expect
 * and what makes the one-line install honest.
 */
function resolveContainer(script: HTMLScriptElement, config: Config): HTMLElement | null {
  if (config.target) {
    const found = document.querySelector<HTMLElement>(config.target);
    if (!found) {
      warn(`target "${config.target}" matched no element`);
      return null;
    }
    return found;
  }

  const container = document.createElement('div');
  script.parentNode?.insertBefore(container, script.nextSibling);
  return container;
}

function warn(message: string): void {
  // eslint-disable-next-line no-console -- the host's console is the only
  // channel we have, and silence here is worse than noise.
  console.warn(`[gnomon] ${message}`);
}

function applyAttributes(element: HTMLElement, config: Config): void {
  const map: Record<string, string> = {
    api: config.api,
    'token-endpoint': config.tokenEndpoint,
    token: config.token,
    calendars: config.calendars,
    view: config.view,
    date: config.date,
    tz: config.tz,
    locale: config.locale,
  };
  for (const [name, value] of Object.entries(map)) {
    if (value) element.setAttribute(name, value);
  }
}

/**
 * The inline path: load the component bundle and use the custom element.
 *
 * Rejects if the bundle cannot be loaded -- which is the signal we use to
 * decide the host's CSP will not have us. A CSP `script-src` violation makes
 * the dynamic import reject, so this doubles as feature detection without
 * having to parse a policy we cannot reliably read.
 */
async function mountInline(container: HTMLElement, config: Config): Promise<void> {
  await import(/* @vite-ignore */ `${config.api}/embed/gnomon-embed.js`);

  if (!customElements.get('gnomon-calendar')) {
    throw new Error('component bundle loaded but did not define gnomon-calendar');
  }

  const element = document.createElement('gnomon-calendar');
  applyAttributes(element, config);
  element.style.display = 'block';
  element.style.height = config.height;
  container.append(element);
}

/**
 * The iframe path (phase 4.7).
 *
 * Slower and less integrated, and it exists so that the answer to "our CSP
 * will not allow that" is never "then you cannot use this".
 *
 * The token is NOT put in the URL. It would end up in the host's referrer
 * logs, in the iframe's own history, and in any analytics that records
 * document URLs. Instead the loader mints it on the host's origin -- where
 * the session cookie lives and only the loader can reach -- and posts it in.
 */
function mountIframe(container: HTMLElement, config: Config): void {
  const url = new URL(`${config.api}/embed/frame`);
  for (const [key, value] of Object.entries({
    calendars: config.calendars,
    view: config.view,
    date: config.date,
    tz: config.tz,
    locale: config.locale,
  })) {
    if (value) url.searchParams.set(key, value);
  }

  const frame = document.createElement('iframe');
  frame.src = url.toString();
  frame.style.border = '0';
  frame.style.width = '100%';
  frame.style.height = config.height;
  frame.title = 'Calendar';
  // allow-same-origin is REQUIRED, not a relaxation. Without it the frame
  // gets an opaque null origin, and `postMessage(msg, gnomonOrigin)` can
  // never match a null origin -- the token is silently dropped and the frame
  // waits for ever. It is also not a weakening here: the frame is
  // cross-origin from the host either way, so "same origin" means Gnomon's
  // own origin, not the portal's. The sandbox still withholds forms,
  // popups, top-level navigation and plugins.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('loading', 'lazy');

  const origin = new URL(config.api, location.href).origin;

  window.addEventListener('message', (event) => {
    // Both checks matter: the origin proves who sent it, and the source
    // check proves it came from THIS frame rather than another one on the
    // page that happens to share the origin.
    if (event.origin !== origin || event.source !== frame.contentWindow) return;
    if ((event.data as { type?: string })?.type !== 'gnomon:ready') return;

    void provideToken(frame, origin, config);
  });

  container.append(frame);
}

async function provideToken(
  frame: HTMLIFrameElement,
  origin: string,
  config: Config,
): Promise<void> {
  let token = config.token;

  if (!token && config.tokenEndpoint) {
    try {
      const response = await fetch(config.tokenEndpoint, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      token = ((await response.json()) as { token?: string }).token ?? '';
    } catch {
      warn('could not reach the token endpoint');
    }
  }

  if (!token) {
    warn('no token available for the embedded calendar');
    return;
  }

  frame.contentWindow?.postMessage({ type: 'gnomon:token', token }, origin);
}

async function start(): Promise<void> {
  const script = ownScript();
  if (!script) {
    warn('could not locate the gnomon script tag; add data-gnomon-api to it');
    return;
  }

  const config = readConfig(script);
  if (!config.token && !config.tokenEndpoint) {
    warn('set data-gnomon-token-endpoint (or data-gnomon-token) so the calendar can authenticate');
    return;
  }

  const container = resolveContainer(script, config);
  if (!container) return;

  if (config.mode === 'iframe') {
    mountIframe(container, config);
    return;
  }

  try {
    await mountInline(container, config);
  } catch (error) {
    if (config.mode === 'inline') {
      warn(`could not load the calendar component: ${String(error)}`);
      return;
    }
    // `auto`: the component could not be loaded, which in practice means the
    // host's CSP refused it. Fall back rather than leaving a blank space.
    warn('component could not be loaded inline; falling back to an iframe');
    mountIframe(container, config);
  }
}

void start();
