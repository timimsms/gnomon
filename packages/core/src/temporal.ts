/**
 * The single point at which Gnomon acquires a Temporal implementation.
 *
 * Per ADR-0006: nothing else in the codebase imports `temporal-polyfill`.
 * L6 originally assumed Node 26 would expose `Temporal` natively and that
 * only browsers would pay for a polyfill. That is false on Node 26.3.0 --
 * `globalThis.Temporal` is `undefined`, and `--harmony-temporal` (which V8
 * reports as defaulting to on) changes nothing.
 *
 * Routing every access through here means the eventual switch to native, or
 * to a feature-detected lazy import, is a one-file change rather than a sweep
 * through every module that touches a date. It also guarantees that server
 * expansion and client preview run the *same* implementation, which is what
 * makes the conformance corpus meaningful in both places.
 */

export { Temporal } from 'temporal-polyfill';
