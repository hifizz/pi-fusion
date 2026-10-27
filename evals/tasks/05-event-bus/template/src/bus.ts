import { SubscriptionStore } from "./registry.ts";
import type { Listener } from "./registry.ts";
export class EventBus {
  private store = new SubscriptionStore();
  on(event: string, listener: Listener): () => void {
    return this.store.add(event, listener);
  }
  once(event: string, listener: Listener): () => void {
    return this.on(event, listener);
  }
  emit(event: string, payload: unknown): number {
    const listeners = this.store.list(event);
    for (const listener of listeners) listener(payload);
    return listeners.length;
  }
}
