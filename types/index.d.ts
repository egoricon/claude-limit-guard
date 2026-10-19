export type Reading = { percent: number; resetsAt: string | null }

declare module 'claude-code' {
  interface PluginState {
    'limit-guard': {
      enabled: boolean
      threshold: number
      reading: Reading | null
      tripped: boolean
      override: boolean
      isOpen: boolean
      allowBackground: boolean
    }
  }
}
