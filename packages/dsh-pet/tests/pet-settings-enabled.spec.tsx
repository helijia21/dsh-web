/** @vitest-environment jsdom */

/**
 * Pet settings card master-switch gating: the Host registers '/api/pet/*'
 * only while the pet is enabled, so the card's registry load must follow the
 * switch — a disabled pet issues no request (a withdrawn route would answer
 * 404), and turning the switch back on loads the registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
// The npm SDK's client half is a closure-factory bundle for the GUI's
// __ModuleLoader__ (not importable under vitest); provide the one value
// member the card chain needs (same pattern as pet-section.spec.tsx).
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: (init: unknown) => {
    let value = init
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => value,
      set: (next: unknown) => { value = next; for (const listener of listeners) listener() },
      update: (mutator: (draft: never) => void) => { mutator(value as never); for (const listener of listeners) listener() },
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
  },
}))
import { PetSettingsCardController, type PetSettings } from '../src/client/PetSettingsCard.tsx'

/** A scope whose 'enabled' switch the test can flip, notifying subscribers. */
class SwitchScope implements SettingsScope<PetSettings> {
  private listeners = new Set<() => void>()
  private readonly user: Partial<PetSettings>
  constructor(enabled: boolean | undefined) {
    this.user = enabled === undefined ? {} : { enabled }
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot(): SettingsScopeSnapshot<PetSettings> {
    return {
      status: 'ready',
      writable: true,
      value: this.user,
      base: {},
      user: this.user,
      revision: 1,
      mode: 'host',
    }
  }
  set = vi.fn(async () => {})
  unset = vi.fn(async () => {})
  mutate = vi.fn(async () => {})
  /** Flip the master switch and notify, as a settings write does. */
  flip(enabled: boolean): void {
    this.user.enabled = enabled
    for (const listener of this.listeners) listener()
  }
}

beforeEach(() => { vi.useFakeTimers() })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function stubFetch() {
  const fetchMock = vi.fn(async (input: string) => {
    if (input === '/api/pet/pets') {
      return new Response(JSON.stringify([{ id: 'whale-girl', displayName: '鲸鱼娘' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ diagnostics: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('PetSettingsCardController master switch', () => {
  it('issues no registry request while the pet is disabled', async () => {
    const fetchMock = stubFetch()
    const controller = new PetSettingsCardController(new SwitchScope(false))

    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchMock).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('loads the registry once the switch is turned on', async () => {
    const fetchMock = stubFetch()
    const scope = new SwitchScope(false)
    const controller = new PetSettingsCardController(scope)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).not.toHaveBeenCalled()

    scope.flip(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledWith('/api/pet/pets')
    expect(controller.inject().hooks.petSettingsCard.getSnapshot().petChoices)
      .toEqual([{ value: 'whale-girl', label: '鲸鱼娘' }])
    controller.dispose()
  })

  it('stops a pending retry when the switch is turned off', async () => {
    const fetchMock = vi.fn(async () => new Response('x', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const scope = new SwitchScope(true)
    const controller = new PetSettingsCardController(scope)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    scope.flip(false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('loads the registry for an unset switch', async () => {
    const fetchMock = stubFetch()
    const controller = new PetSettingsCardController(new SwitchScope(undefined))

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledWith('/api/pet/pets')
    controller.dispose()
  })
})
