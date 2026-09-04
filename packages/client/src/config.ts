/**
 * Client-side endpoint configuration.
 *
 * Every API and WebSocket URL in the client resolves through here, so the
 * port lives in exactly one place. Ports sit high in the range on purpose —
 * 3000/3001 collide with almost every other dev server on a machine.
 *
 * The host comes from the page's own location rather than a baked-in address,
 * so one build works on localhost, over a LAN, and through a tunnel alike.
 * Override either URL at build time with VITE_API_URL / VITE_WS_URL.
 */

/** Default port the GraphCoder API server listens on. */
export const DEFAULT_API_PORT = 3357

/** Base URL for REST calls, e.g. `http://localhost:3357`. */
export const API_BASE: string = import.meta.env.VITE_API_URL ?? `http://${window.location.hostname}:${DEFAULT_API_PORT}`

/** WebSocket endpoint for live graph updates. */
export const WS_URL: string = import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:${DEFAULT_API_PORT}/ws`
