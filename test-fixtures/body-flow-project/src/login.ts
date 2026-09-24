import { validate } from './validate.js'

export function login(user: string): string {
  return `session:${user}`
}

/**
 * Entry point: only the `validate` → `login` path leads on to other traced functions.
 */
export function handleLogin(user: string, password: string): string {
  if (!user) {
    throw new Error('missing user')
  }
  const ok = validate(user, password)
  if (ok) {
    return login(user)
  }
  return JSON.stringify({ error: 'denied' })
}
