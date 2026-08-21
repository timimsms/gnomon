/**
 * `?inline` CSS imports are a Vite feature, and this package is built with
 * Vite. Declared here so `tsc` understands the shape without the whole
 * package depending on Vite's client types.
 */
declare module '*.css?inline' {
  const css: string;
  export default css;
}
