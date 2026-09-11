# Agent Note: Pet settings card registry load follows the master switch

Status: implemented

## Problem

With the pet master switch off (`pet: { enabled: false }` in `settings.yaml`), the browser still issued `GET /api/pet/pets` and `GET /api/pet/diagnostics`, and the server answered 404. The console filled with `Failed to load resource: the server responded with a status of 404 (Not Found)`.

The host half registers its `/api/pet/*` routes only while the switch is on: `packages/dsh-pet/src/index.ts` tears the routes down through `syncRoutes()` when `enabled` is false, and `packages/host/webserver` answers 404 for any path no route claims. So `enabled: false` means "these endpoints do not exist", not "these endpoints refuse".

The browser half read that verdict in one place only. `packages/dsh-pet/src/client/index.ts` gates the floating sprite's poll loop on `enabled()`, but it constructed `PetSettingsCardController` unconditionally, and the controller's constructor armed a deferred timer that fetched the registry regardless. `loadPets` also retried three times, three seconds apart, so a disabled pet produced a recurring 404 stream rather than one failed request.

The asymmetry is the defect: one switch, two consumers, and only one of them consulted it.

## Decision

The card's registry load follows the master switch, read from the same predicate as the sprite.

`petEnabled(snapshot)` in `packages/dsh-pet/src/client/PetSettingsCard.tsx` is now the single switch predicate. `packages/dsh-pet/src/client/index.ts` calls it for the sprite's poll loop instead of carrying its own copy, so both consumers cannot drift apart again. An unset `enabled` means on (the schema default); a `loading` namespace counts as off, so the first load waits for the verdict rather than firing against routes that may not exist yet; an `unavailable` namespace counts as on, because there is no switch to consult. The switch's meaning as the plugin master switch was established by [remote presence hides and restores the pet](2026-08-30-remote-presence-pet-visibility.md); this note extends which consumers honor it.

`PetSettingsCardController` subscribes to its settings scope and routes every load through `syncLoad()`, which consults the switch before fetching. Consequences of that shape:

- A disabled pet issues no request at all, so no 404 is produced.
- Turning the switch on loads the registry, because the settings subscription re-runs `syncLoad()`.
- A retry timer armed by a failure is cancelled when the switch turns off, and the retry budget resets when it turns back on: the endpoints were withdrawn in between, so earlier failures say nothing about the routes that exist now.
- In-flight guards (`petsLoading`, `diagnosticsLoading`, `retryScheduled`) keep a settings notification that lands mid-load from starting a second one.
- The controller owns its scope subscription (`disposeScope`) and releases it in `dispose()`, which previously released only the form's own subscription.

The settings card itself stays registered while the pet is off. It is the surface that turns the pet back on, so hiding it with the pet would strand the user.

## Testing

`packages/dsh-pet/tests/pet-settings-enabled.spec.tsx` covers the switch contract: no request while disabled (including across the retry window), a load once the switch turns on, a pending retry dropped when the switch turns off, and a load for an unset switch.

The existing specs' fake scopes carried no `status` field, which the new predicate reads; `pet-diagnostics.spec.tsx` and `pet-settings-dispose.spec.tsx` now report `status: 'ready'`, matching the real scope.

`pnpm --filter @linxin666/dsh-pet typecheck` and the package suite (497 tests) pass.

## Alternatives considered

**Keep the host routes registered while the pet is off.** This would delete the 404 by making the endpoints always exist. It was rejected because route withdrawal is the declared meaning of the switch: `packages/dsh-pet/src/routes.ts` and the host `apply` body both document that disabling the pet makes its API disappear, and the pairing fence plus the asset routes share that lifetime. Widening the exposed surface to spare one client request inverts the contract.

**Gate the card's load on first render of the settings page (lazy load).** This also removes the idle requests, and it would additionally avoid fetching for users who never open the pet settings page. It was rejected as the fix here because it does not by itself follow the switch: a user who opens the page while the pet is disabled would still fetch. It remains a plausible independent improvement.

**Leave the controller unconditional and suppress the resulting 404 in the console.** This hides the symptom while the browser keeps calling routes the host has withdrawn, and it would mask a genuinely missing route later. It was rejected because the request itself is the defect, not its logging.
