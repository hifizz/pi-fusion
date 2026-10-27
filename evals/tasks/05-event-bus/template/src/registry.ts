export type Listener = (payload: unknown) => void;
export class SubscriptionStore {
  private listeners = new Map<string, Listener[]>();
  add(event: string, listener: Listener): () => void {
    this.listeners.set(event, [listener]);
    return () => { this.listeners.delete(event); };
  }
  list(event: string): Listener[] {
    return this.listeners.get(event) ?? [];
  }
}
