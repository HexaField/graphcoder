/**
 * Shared endpoint configuration for the E2E suite.
 *
 * Kept in one place so a port change touches a single file rather than every
 * spec. Mirrors the defaults in `src/config.ts` and `vite.config.ts`.
 */

/** Client dev-server port — must match vite.config.ts */
export const CLIENT_PORT = 3356

/** API server port — must match packages/server/src/index.ts */
export const API_PORT = 3357

/** Base URL of the API server under test. */
export const SERVER: string = process.env.VITE_API_URL ?? `http://localhost:${API_PORT}`

/** Base URL the browser navigates to. */
export const BASE_URL: string = `http://localhost:${CLIENT_PORT}`
