import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import type { EventOccurrence } from '@gnomon/core';
import { eventCalendarAdapter } from './adapters/event-calendar.js';
import type { RendererAdapter, RendererAdapterFactory, ViewName } from './adapter.js';
import { ApiError, CalendarClient, TokenError, endpointToken, staticToken } from './client.js';
import type { TokenProvider } from './client.js';
import { tokenToCustomProperty, type ThemeTokens } from './theme.js';

/**
 * `<gnomon-calendar>` (phase 4.4).
 *
 * A real custom element with Shadow DOM, because it mounts into someone
 * else's portal and has to survive their stylesheet. Shadow DOM is the
 * primary defence; the iframe fallback (4.7) exists for hosts whose CSP
 * forbids even this.
 *
 * The element owns the chrome -- navigation, view switching, and the loading,
 * error and empty states. Both adapters have their renderer's own toolbar
 * suppressed, so the two look identical rather than each showing its own.
 *
 * NOTE: this package sets `useDefineForClassFields: false`. At ES2022+ the
 * default is true, and native class fields then OVERWRITE the accessors Lit
 * installs for reactive properties -- the element renders once, empty, and
 * never updates again. Lit detects it and warns, but only at runtime in dev
 * mode; typecheck and build are both perfectly happy. Removing that flag
 * breaks this component silently in production.
 */

const DAY_MS = 86_400_000;

export class GnomonCalendar extends LitElement {
  static override properties = {
    api: { type: String },
    token: { type: String },
    tokenEndpoint: { type: String, attribute: 'token-endpoint' },
    calendars: { type: String },
    view: { type: String },
    date: { type: String },
    tz: { type: String },
    locale: { type: String },
    _occurrences: { state: true },
    _status: { state: true },
    _message: { state: true },
  };

  /** Base URL of the Gnomon API. */
  api = '';
  /** A token, for demos and tests. Prefer `token-endpoint`. */
  token = '';
  /** Endpoint on the HOST's domain that mints a token for the current user. */
  tokenEndpoint = '';
  /** Comma-separated calendar ids. Defaults to everything the token grants. */
  calendars = '';
  view: ViewName = 'month';
  /** ISO calendar date the view opens on. Defaults to today. */
  date = '';
  tz = '';
  locale = '';

  declare private _occurrences: EventOccurrence[];
  declare private _status: 'idle' | 'loading' | 'ready' | 'error';
  declare private _message: string;

  #adapter: RendererAdapter | null = null;
  #client: CalendarClient | null = null;
  /**
   * Kept separate from the client, and rebuilt only when the token source
   * itself changes. Folding it into the client meant every attribute change
   * -- including the initial ones -- threw away the cached token and minted a
   * fresh one against the host's endpoint.
   */
  #tokens: TokenProvider | null = null;
  #tokenSource = '';
  #inFlight: AbortController | null = null;
  #factory: RendererAdapterFactory = eventCalendarAdapter;
  #theme: ThemeTokens = {};

  constructor() {
    super();
    this._occurrences = [];
    this._status = 'idle';
    this._message = '';
  }

  /**
   * Swap the renderer. Nothing else in this class knows which one is in use
   * -- that is the seam ADR-0003 bought, and the conformance suite is what
   * keeps it honest.
   */
  setRendererAdapter(factory: RendererAdapterFactory): void {
    this.#factory = factory;
    if (this.#adapter) {
      this.#teardownAdapter();
      this.#setupAdapter();
    }
  }

  setTheme(tokens: ThemeTokens): void {
    this.#theme = tokens;
    for (const [name, value] of Object.entries(tokens)) {
      if (value) this.style.setProperty(tokenToCustomProperty(name as keyof ThemeTokens), value);
    }
    this.#adapter?.setTheme(tokens);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.date) this.date = todayIso(this.#timeZone());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Abort in flight work before teardown: a fetch resolving into a
    // destroyed renderer is the classic detached-element crash.
    this.#inFlight?.abort();
    this.#teardownAdapter();
  }

  override firstUpdated(): void {
    this.#setupAdapter();
    void this.#load();
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('view') && this.#adapter) this.#adapter.setView(this.view);
    if (changed.has('date') && this.#adapter) this.#adapter.setDate(this.date);

    // Any of these changes the window or the identity of what we are asking
    // for, so the data has to be refetched rather than re-filtered.
    const refetchTriggers = ['api', 'token', 'tokenEndpoint', 'calendars', 'date', 'tz'] as const;
    if (changed.has('api')) this.#client = null;
    if (refetchTriggers.some((key) => changed.has(key))) {
      void this.#load();
    }
  }

  #setupAdapter(): void {
    const host = this.renderRoot.querySelector<HTMLElement>('.gnomon-surface');
    if (!host) return;

    this.#adapter = this.#factory.create();
    this.#adapter.on('rangeChange', ({ from }) => {
      // The renderer shows a padded range -- a month view includes trailing
      // days of the previous month. Following it directly would refetch on
      // every render, so only a genuine month change moves `date`.
      const next = from.slice(0, 10);
      if (next.slice(0, 7) !== this.date.slice(0, 7)) {
        this.date = next;
      }
    });
    this.#adapter.on('occurrenceClick', ({ occurrence }) => {
      this.dispatchEvent(
        // Composed so the host can listen on their own container rather than
        // having to reach through the shadow boundary.
        new CustomEvent('gnomon-occurrence-click', {
          detail: occurrence,
          bubbles: true,
          composed: true,
        }),
      );
    });

    this.#adapter.mount(host, {
      view: this.view,
      date: this.date,
      timeZone: this.#timeZone(),
      ...(this.locale ? { locale: this.locale } : {}),
      theme: this.#theme,
    });
    this.#adapter.setEvents(this._occurrences);
  }

  #teardownAdapter(): void {
    this.#adapter?.destroy();
    this.#adapter = null;
  }

  #timeZone(): string {
    return this.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  async #load(): Promise<void> {
    if (!this.api) return;
    if (!this.token && !this.tokenEndpoint) {
      this.#fail('No token or token-endpoint configured.');
      return;
    }

    this.#inFlight?.abort();
    const controller = new AbortController();
    this.#inFlight = controller;

    this._status = 'loading';
    this._message = '';

    const source = this.token ? `static:${this.token}` : `endpoint:${this.tokenEndpoint}`;
    if (!this.#tokens || this.#tokenSource !== source) {
      this.#tokens = this.token ? staticToken(this.token) : endpointToken(this.tokenEndpoint);
      this.#tokenSource = source;
    }

    this.#client ??= new CalendarClient({ baseUrl: this.api, tokens: this.#tokens });

    const [from, to] = this.#window();

    try {
      const occurrences = await this.#client.fetchEvents({
        from,
        to,
        tz: this.#timeZone(),
        ...(this.calendars ? { calendarIds: this.calendars.split(',').map((c) => c.trim()) } : {}),
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;
      this._occurrences = occurrences;
      this._status = 'ready';
      this.#adapter?.setEvents(occurrences);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.#fail(describe(error));
    }
  }

  /**
   * The fetch window: the visible month plus a week of padding either side,
   * which covers the leading and trailing days a month grid draws.
   */
  #window(): [string, string] {
    const anchor = new Date(`${this.date || todayIso(this.#timeZone())}T00:00:00Z`);
    const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
    return [
      new Date(start.getTime() - 7 * DAY_MS).toISOString(),
      new Date(end.getTime() + 7 * DAY_MS).toISOString(),
    ];
  }

  #fail(message: string): void {
    this._status = 'error';
    this._message = message;
    // Surfaced as an event as well as on screen: a host that hides our UI
    // still needs to know, and "the calendar is blank" is not a diagnosis.
    this.dispatchEvent(
      new CustomEvent('gnomon-error', { detail: { message }, bubbles: true, composed: true }),
    );
  }

  #move(months: number): void {
    const anchor = new Date(`${this.date}T00:00:00Z`);
    this.date = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, 1))
      .toISOString()
      .slice(0, 10);
  }

  override render() {
    return html`
      <div class="gnomon-root" part="root">
        <div class="gnomon-chrome" part="chrome">
          <div class="gnomon-nav">
            <button part="button" aria-label="Previous month" @click=${() => this.#move(-1)}>‹</button>
            <button part="button" @click=${() => { this.date = todayIso(this.#timeZone()); }}>
              Today
            </button>
            <button part="button" aria-label="Next month" @click=${() => this.#move(1)}>›</button>
          </div>
          <div class="gnomon-views" role="group" aria-label="View">
            ${(['month', 'agenda'] as const).map(
              (name) => html`
                <button
                  part="button"
                  aria-pressed=${this.view === name}
                  @click=${() => { this.view = name; }}
                >
                  ${name === 'month' ? 'Month' : 'Agenda'}
                </button>
              `,
            )}
          </div>
        </div>

        ${this._status === 'error'
          ? html`<div class="gnomon-error" part="error" role="alert">${this._message}</div>`
          : nothing}

        <!--
          The surface is always in the DOM, never conditionally rendered: the
          adapter holds a reference to it, and swapping the node under a live
          renderer detaches it silently. Loading state is an overlay instead.
        -->
        <div class="gnomon-surface" part="surface"></div>

        ${this._status === 'loading'
          ? html`<div class="gnomon-loading" part="loading" aria-live="polite">Loading…</div>`
          : nothing}
      </div>
    `;
  }

  static override styles = css`
    :host {
      /* Every token defaults here, so an integrator who sets nothing still
         gets a working calendar, and setting one on any ancestor overrides
         just that one. */
      --gnomon-font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      --gnomon-font-size: 14px;
      --gnomon-text-colour: #1a1a1a;
      --gnomon-muted-text-colour: #6b6b6b;
      --gnomon-surface-colour: #ffffff;
      --gnomon-border-colour: #d8d8d8;
      --gnomon-accent-colour: #1f5c8b;
      --gnomon-accent-text-colour: #ffffff;
      --gnomon-today-colour: #eef4f9;
      --gnomon-focus-colour: #1f5c8b;
      --gnomon-radius: 4px;
      --gnomon-gap: 2px;

      display: block;
      /* contain: stops our layout from perturbing the host's, which matters
         when the host drops us into a flex row they have already balanced. */
      contain: layout style;
      font-family: var(--gnomon-font-family);
      font-size: var(--gnomon-font-size);
      color: var(--gnomon-text-colour);
      background: var(--gnomon-surface-colour);
      min-height: 320px;
    }

    .gnomon-root {
      display: flex;
      flex-direction: column;
      height: 100%;
      position: relative;

      /* Restated here, not only on :host, and this is not redundant.
         Shadow DOM stops the host's SELECTORS from matching inside, but it
         does not stop INHERITANCE. A host rule like
         * { font-family: X !important } matches <gnomon-calendar> itself,
         and every node in the shadow tree then inherits that computed value
         -- the boundary is never crossed, so nothing is "leaking", but the
         result looks identical to a leak. A declaration inside the tree beats
         an inherited value regardless of !important outside, because
         inheritance carries no specificity. */
      font-family: var(--gnomon-font-family);
      font-size: var(--gnomon-font-size);
      color: var(--gnomon-text-colour);
      font-style: normal;
      font-weight: normal;
      letter-spacing: normal;
      text-transform: none;
      line-height: 1.4;
    }

    .gnomon-chrome {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 8px;
      border-bottom: 1px solid var(--gnomon-border-colour);
    }

    .gnomon-nav,
    .gnomon-views {
      display: flex;
      gap: var(--gnomon-gap);
    }

    button {
      font: inherit;
      color: inherit;
      /* Same reasoning: the host's button { text-transform: uppercase }
         reaches our buttons by inheritance of the computed value. */
      text-transform: none;
      letter-spacing: normal;
      background: transparent;
      border: 1px solid var(--gnomon-border-colour);
      border-radius: var(--gnomon-radius);
      padding: 4px 10px;
      cursor: pointer;
    }

    button[aria-pressed='true'] {
      background: var(--gnomon-accent-colour);
      color: var(--gnomon-accent-text-colour);
      border-color: var(--gnomon-accent-colour);
    }

    /* A visible focus ring that survives a host reset: the host cannot reach
       inside the shadow boundary to remove it. */
    button:focus-visible {
      outline: 2px solid var(--gnomon-focus-colour);
      outline-offset: 2px;
    }

    .gnomon-surface {
      flex: 1 1 auto;
      min-height: 280px;
    }

    .gnomon-error {
      padding: 8px 12px;
      color: var(--gnomon-text-colour);
      background: var(--gnomon-today-colour);
      border-bottom: 1px solid var(--gnomon-border-colour);
    }

    .gnomon-loading {
      position: absolute;
      inset-block-start: 50%;
      inset-inline-start: 50%;
      transform: translate(-50%, -50%);
      color: var(--gnomon-muted-text-colour);
    }

    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
        animation: none !important;
      }
    }
  `;
}

function todayIso(timeZone: string): string {
  // `en-CA` yields YYYY-MM-DD, which avoids hand-assembling parts and is
  // correct for the requested zone rather than the browser's.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function describe(error: unknown): string {
  if (error instanceof TokenError) return `Could not obtain a token. ${error.message}`;
  if (error instanceof ApiError) {
    return error.code === 'window_too_large'
      ? 'The requested range is too large.'
      : `Gnomon returned an error (${error.code}).`;
  }
  return 'The calendar could not be loaded.';
}

/**
 * Registration is idempotent: two copies of the loader on one page is a
 * realistic accident, and the second must not throw and take the host's
 * script down with it.
 */
export function defineGnomonCalendar(tag = 'gnomon-calendar'): void {
  if (!customElements.get(tag)) customElements.define(tag, GnomonCalendar);
}

declare global {
  interface HTMLElementTagNameMap {
    'gnomon-calendar': GnomonCalendar;
  }
}
