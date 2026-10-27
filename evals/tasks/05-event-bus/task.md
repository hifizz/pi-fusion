Complete the event system across `src/registry.ts`, `src/bus.ts` and `src/history.ts`.

- `SubscriptionStore.add(event, listener)` stores an independent subscription and returns an idempotent unsubscribe function. Registering the same callback twice must produce two independent subscriptions. `list(event)` returns a snapshot in registration order.
- `EventBus.on` delegates to the store. `once` removes its subscription before calling the listener and invokes it at most once, even when another listener triggers a nested emit before its turn.
- `emit(event, payload)` synchronously invokes the listeners present when that emit started, in registration order, and returns their count. Additions/removals during emit affect only later emits. Listener exceptions propagate synchronously.
- `record(bus, event)` returns `{events, stop}`. `events` accumulates payloads while subscribed, including undefined/null. `stop()` is idempotent and leaves the history available.

Preserve exported signatures. Run `npm test`; no dependencies.
