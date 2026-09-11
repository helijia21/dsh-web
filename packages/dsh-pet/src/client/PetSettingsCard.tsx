/**
 * The pet settings card: pet selection plus display layout, bound to the
 * 'pet' settings namespace the host plugin registers. Rendered as an
 * always-open first-level settings page; the section wrapper below mounts it
 * as the content of the top-level 'settings.section' nav entry. The petId
 * choices come from the registry endpoint ('/api/pet/pets') — the same list
 * the sprite renders from — so the card carries no per-pet knowledge.
 *
 * The card's registry requests follow the master switch: the Host registers
 * '/api/pet/*' only while the pet is enabled, so a disabled pet has no
 * endpoint to answer and the card loads only once the switch is on.
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the settings-surface SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PluginSettingsCard, ValueField, BooleanField, ChoiceField } from './PluginSettingsCard.tsx'
import { CardForm, booleanField, choiceField, numberField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'
import sectionCss from './settings-section.module.css'

/** The pet's settings fields this card edits (the namespace's full schema). */
export interface PetSettings {
  /** Master switch for the plugin. */
  enabled?: boolean
  /** Master switch. */
  visible?: boolean
  /** Scale of the rendered pet in px (sprite cell height). */
  size?: number
  /** Horizontal inset from the viewport right edge, px. */
  right?: number
  /** Vertical inset from the viewport bottom edge, px. */
  bottom?: number
  /** Selected pet id (a registry entry). */
  petId?: string
  /** Status-decoration master switch (pet-center M5, #567). */
  decorationEnabled?: boolean
}

/** What the pet settings card renders. */
export interface PetSettingsCardState extends CardShell {
  /** Plugin master switch. */
  enabled: CardFieldState
  /** Master switch. */
  visible: CardFieldState
  /** Pet scale. */
  size: CardFieldState
  /** Right inset. */
  right: CardFieldState
  /** Bottom inset. */
  bottom: CardFieldState
  /** Selected pet. */
  petId: CardFieldState
  /** Status-decoration master switch. */
  decorationEnabled: CardFieldState
  /** Pet choices (registry ids + display names), loaded from the host. */
  petChoices: readonly { value: string; label: string }[]
  /** Registry diagnostics (v1 migration hints, invalid entries), host-served. */
  petDiagnostics: readonly PetDiagnosticView[]
}

/** The registration-side face the card's slot entry injects. */
export interface PetSettingsCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as usePetSettingsCard. */
    petSettingsCard: SnapshotStore<PetSettingsCardState>
  }
}

/**
 * Whether the pet master switch is on for a 'pet' scope snapshot.
 *
 * The Host registers its '/api/pet/*' routes only while the switch is on, so
 * every browser-side consumer — the floating sprite and the settings card's
 * registry load — reads the same verdict here instead of each inventing one.
 * An unset switch means on (the schema default). A namespace the deployment
 * does not serve counts as on, because there is no switch to consult; a
 * namespace still loading counts as off, so the load waits for the verdict
 * rather than firing against routes that may not exist yet.
 * @param snapshot - the bound 'pet' settings scope snapshot.
 * @returns whether the pet is enabled.
 */
export function petEnabled(snapshot: SettingsScopeSnapshot<PetSettings>): boolean {
  return snapshot.status === 'ready'
    ? snapshot.value?.enabled ?? true
    : snapshot.status === 'unavailable'
}

/** One registry choice as served by '/api/pet/pets'. */
interface PetChoice {
  id: string
  displayName: string
}

/** One registry diagnostic as served by '/api/pet/diagnostics' (#623). */
export interface PetDiagnosticView {
  level: 'error' | 'warning'
  message: string
}

/** Fetch the registry list (the same data the sprite renders from). */
async function fetchPetChoices(): Promise<PetChoice[]> {
  const response = await fetch('/api/pet/pets')
  if (!response.ok) throw new Error('pet pets failed: ' + response.status)
  return (await response.json()) as PetChoice[]
}

/** Fetch the registry diagnostics (v1 migration hints, invalid entries). */
async function fetchPetDiagnostics(): Promise<PetDiagnosticView[]> {
  const response = await fetch('/api/pet/diagnostics')
  if (!response.ok) throw new Error('pet diagnostics failed: ' + response.status)
  const body = (await response.json()) as { diagnostics?: PetDiagnosticView[] }
  return body.diagnostics ?? []
}

/** Bridges the 'pet' scope onto the card's staged form. */
export class PetSettingsCardController {
  private readonly form: CardForm<PetSettings>
  private readonly store: SnapshotStore<PetSettingsCardState>
  // The choice list rides a mutable array shared with the choiceField spec,
  // so loading the registry re-validates and re-formats the petId field
  // without rebuilding the form.
  private readonly petChoices: string[] = []
  private readonly petLabels = new Map<string, string>()
  private diagnostics: PetDiagnosticView[] = []
  private loaded = false
  private diagnosticsLoaded = false
  /** In-flight guards: a settings change during a load must not start a second one. */
  private petsLoading = false
  private diagnosticsLoading = false
  /** Whether a failed pets load already armed its retry timer. */
  private retryScheduled = false
  private attempts = 0
  /** The master-switch verdict the previous load decision saw. */
  private wasEnabled = false
  private disposed = false
  /** The controller's own scope subscription; released by dispose(). */
  private readonly disposeScope: () => void
  /** Pending deferred-load or retry timer; cancelled by dispose(). */
  private pendingTimer: number | undefined

  /** @param scope - the bound settings scope for the 'pet' namespace. */
  constructor(private readonly scope: SettingsScope<PetSettings>) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      booleanField('decorationEnabled'),
      booleanField('visible'),
      numberField('size'),
      numberField('right'),
      numberField('bottom'),
      choiceField('petId', this.petChoices),
    ])
    this.store = this.form.bind(() => this.projection())
    // The registry endpoints exist only while the master switch is on, so a
    // load is attempted when the switch permits it and retried when a later
    // settings change turns it on.
    this.disposeScope = scope.subscribe(() => { this.syncLoad() })
    // Client plugins are applied synchronously during shell startup. Defer
    // the first registry request until that pass completes so transport
    // plugins (notably remote-web-ui on a paired non-loopback origin) can
    // install their fetch channel before /api/pet/pets is issued.
    this.pendingTimer = window.setTimeout(() => {
      this.pendingTimer = undefined
      this.syncLoad()
    }, 0)
  }

  /** Whether the master switch currently permits the registry endpoints to exist. */
  private enabled(): boolean {
    return petEnabled(this.scope.getSnapshot())
  }

  /** Load whatever the registry still owes, while the master switch permits it. */
  private syncLoad(): void {
    const enabled = this.enabled()
    // A switch that just came back on earns a fresh retry budget: the
    // endpoints were withdrawn in between, so the earlier failures say
    // nothing about the routes that exist now.
    if (enabled && !this.wasEnabled) this.attempts = 0
    if (!enabled && this.retryScheduled) {
      // The routes are gone; drop the armed retry so re-enabling loads at
      // once instead of waiting out a timer that would fail again.
      this.cancelPendingTimer()
      this.retryScheduled = false
    }
    this.wasEnabled = enabled
    if (this.disposed || !enabled) return
    if (!this.loaded && !this.petsLoading && !this.retryScheduled) void this.loadPets()
    if (!this.diagnosticsLoaded && !this.diagnosticsLoading) void this.loadDiagnostics()
  }

  /** Drop the armed deferred-load or retry timer, if any. */
  private cancelPendingTimer(): void {
    if (this.pendingTimer === undefined) return
    window.clearTimeout(this.pendingTimer)
    this.pendingTimer = undefined
  }

  /** Fetch registry diagnostics once (soft-fail: an empty list on error). */
  private async loadDiagnostics(): Promise<void> {
    if (this.diagnosticsLoaded || this.disposed) return
    this.diagnosticsLoading = true
    try {
      const diagnostics = await fetchPetDiagnostics()
      if (this.disposed) return
      this.diagnostics = diagnostics
      this.store.set(this.projection())
    } catch {
      // A deployment whose diagnostics route is absent or failing still gets
      // the card: the chooser carries the section, the hints are extra.
      this.diagnostics = []
    } finally {
      this.diagnosticsLoading = false
      this.diagnosticsLoaded = true
    }
  }

  /** Resolve the registry choices once (retried a few times on failure). */
  private async loadPets(): Promise<void> {
    if (this.loaded || this.disposed) return
    this.petsLoading = true
    try {
      const list = await fetchPetChoices()
      if (this.disposed) return
      this.petChoices.splice(0, this.petChoices.length, ...list.map(choice => choice.id))
      for (const choice of list) this.petLabels.set(choice.id, choice.displayName)
      this.loaded = true
      this.store.set(this.projection())
    } catch {
      if (this.disposed) return
      this.attempts += 1
      if (this.attempts < 3) {
        this.retryScheduled = true
        this.pendingTimer = window.setTimeout(() => {
          this.pendingTimer = undefined
          this.retryScheduled = false
          // Re-check the switch: a retry that fires after the pet was turned
          // off must not issue another request against its withdrawn routes.
          this.syncLoad()
        }, 3000)
      }
    } finally {
      this.petsLoading = false
    }
  }

  private projection(): PetSettingsCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      decorationEnabled: this.form.field('decorationEnabled'),
      visible: this.form.field('visible'),
      size: this.form.field('size'),
      right: this.form.field('right'),
      bottom: this.form.field('bottom'),
      petId: this.form.field('petId'),
      petChoices: this.petChoices.map(id => ({ value: id, label: this.petLabels.get(id) ?? id })),
      petDiagnostics: this.diagnostics,
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): PetSettingsCardFace {
    return { hooks: { petSettingsCard: this.store }, ...this.form.actions() }
  }

  /**
   * Release the card's scope subscriptions, bound stores and pending load
   * timers; the slot disposer calls this on teardown.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelPendingTimer()
    this.disposeScope()
    this.form.dispose()
  }
}

/** Props the renderer binds for the pet settings card. */
export type PetSettingsCardProps =
  PropsLocale<'pet'>
  & InjectFace<PetSettingsCardFace>

/**
 * Render the pet settings card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function PetSettingsCard(props: PetSettingsCardProps) {
  const { t } = props
  const state = props.usePetSettingsCard(snapshot => snapshot)
  const disabled = !state.writable
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }
  return (
    <PluginSettingsCard
      t={t}
      titleKey="settings.title"
      descriptionKey="settings.description"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
      alwaysOpen
    >
      <BooleanField
        id="settings-pet-enabled"
        label={t('settings.enabled')}
        hint={t('settings.enabledHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <BooleanField
        id="settings-pet-decoration"
        label={t('settings.decoration')}
        hint={t('settings.decorationHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.decorationEnabled}
        onEdit={(text) => { props.edit('decorationEnabled', text) }}
        onReset={() => { props.resetField('decorationEnabled') }}
      />
      <ChoiceField
        id="settings-pet-pet"
        label={t('settings.pet')}
        hint={t('settings.petHint')}
        inheritLabel={t('settings.inherit')}
        {...fieldProps}
        {...state.petId}
        choices={state.petChoices}
        onEdit={(text) => { props.edit('petId', text) }}
        onReset={() => { props.resetField('petId') }}
      />
      {state.petDiagnostics.length === 0 ? null : (
        <li className={sectionCss.diagnostics} data-dsh-part="diagnostics">
          <span className={sectionCss.diagnosticsTitle}>{t('settings.diagnosticsTitle')}</span>
          <ul>
            {state.petDiagnostics.map((diagnostic, index) => (
              <li key={index} data-level={diagnostic.level}>{diagnostic.message}</li>
            ))}
          </ul>
        </li>
      )}
      <BooleanField
        id="settings-pet-visible"
        label={t('settings.visible')}
        hint={t('settings.visibleHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.visible}
        onEdit={(text) => { props.edit('visible', text) }}
        onReset={() => { props.resetField('visible') }}
      />
      <ValueField
        id="settings-pet-size"
        label={t('settings.size')}
        hint={t('settings.sizeHint')}
        numeric
        {...fieldProps}
        {...state.size}
        onEdit={(text) => { props.edit('size', text) }}
        onReset={() => { props.resetField('size') }}
      />
      <ValueField
        id="settings-pet-right"
        label={t('settings.right')}
        hint={t('settings.rightHint')}
        numeric
        {...fieldProps}
        {...state.right}
        onEdit={(text) => { props.edit('right', text) }}
        onReset={() => { props.resetField('right') }}
      />
      <ValueField
        id="settings-pet-bottom"
        label={t('settings.bottom')}
        hint={t('settings.bottomHint')}
        numeric
        {...fieldProps}
        {...state.bottom}
        onEdit={(text) => { props.edit('bottom', text) }}
        onReset={() => { props.resetField('bottom') }}
      />
    </PluginSettingsCard>
  )
}

/** Props the settings section binds for the pet card page. */
export type PetSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'pet'>
  & InjectFace<PetSettingsCardFace>

/** Render the pet settings card as a first-level settings page. */
export function PetSettingsSection(props: PetSettingsSectionProps): ReactNode {
  const { t, usePetSettingsCard, save, discard, edit, resetField } = props
  return (
    <ul className={sectionCss.sectionList}>
      <PetSettingsCard t={t} usePetSettingsCard={usePetSettingsCard} save={save} discard={discard} edit={edit} resetField={resetField} />
    </ul>
  )
}
