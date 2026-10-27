import type { EventBus } from "./bus.ts";
export function record(bus: EventBus, event: string): { events: unknown[]; stop: () => void } {
  const events: unknown[] = [];
  const stop = bus.on(event, (payload) => { events.push(payload); });
  return { events, stop };
}
