import { describe, it, expect } from 'vitest'
import { agentSessionEnd } from '../agent-session-seam'

describe('agentSessionEnd seam', () => {
  it('ends the slot, then unlocks history (prefs.rs:209 order)', () => {
    const calls: string[] = []
    agentSessionEnd({ endSlot: () => calls.push('end'), unlockHistory: () => calls.push('unlock') })
    expect(calls).toEqual(['end', 'unlock'])
  })
})
