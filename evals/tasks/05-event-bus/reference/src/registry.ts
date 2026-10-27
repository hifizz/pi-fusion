export type Listener = (payload: unknown) => void;
export class SubscriptionStore {
  private listeners = new Map<string, Map<symbol, Listener>>();
  add(event: string, listener: Listener): () => void {
    const subscriptions = this.listeners.get(event) ?? new Map<symbol, Listener>();
    this.listeners.set(event, subscriptions);
    const id = Symbol();
    subscriptions.set(id, listener);
    return () => {
      subscriptions.delete(id);
      if (!subscriptions.size && this.listeners.get(event) === subscriptions) this.listeners.delete(event);
    };
  }
  list(event: string): Listener[] {
    return [...(this.listeners.get(event)?.values() ?? [])];
  }
}
