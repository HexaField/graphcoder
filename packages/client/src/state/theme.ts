import { createEffect, createMemo, createRoot, createSignal } from 'solid-js'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const CYCLE: ThemeMode[] = ['light', 'dark', 'system']
const STORAGE_KEY = 'graphcoder-theme'

// createRoot keeps signals alive outside any component lifecycle.
// Disposal never runs — these signals live for the full app lifetime.
export const { theme, resolvedTheme, cycleTheme } = createRoot(() => {
  const stored = (localStorage.getItem(STORAGE_KEY) as ThemeMode | null) ?? 'system'
  const [theme, setTheme] = createSignal<ThemeMode>(stored)

  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const [sysDark, setSysDark] = createSignal(mq.matches)
  mq.addEventListener('change', (e) => setSysDark(e.matches))

  const resolvedTheme = createMemo<ResolvedTheme>(() => {
    const t = theme()
    if (t === 'system') return sysDark() ? 'dark' : 'light'
    return t
  })

  // Keep <html class="dark"> in sync and persist the user's choice.
  createEffect(() => {
    const html = document.documentElement
    if (resolvedTheme() === 'dark') {
      html.classList.add('dark')
    } else {
      html.classList.remove('dark')
    }
    localStorage.setItem(STORAGE_KEY, theme())
  })

  const cycleTheme = () => {
    const idx = CYCLE.indexOf(theme())
    setTheme(CYCLE[(idx + 1) % CYCLE.length])
  }

  return { theme, resolvedTheme, cycleTheme }
})
