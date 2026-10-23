import 'server-only';

/**
 * The time a server component renders at. Server components render once per request, so reading
 * the clock there is intended (the react-hooks purity rule targets components that re-render).
 */
export function requestTime(): number {
  return Date.now();
}
