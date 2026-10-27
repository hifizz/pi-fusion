import type { EventBus } from "./bus.ts";
export function record(bus: EventBus, event: string): { events: unknown[]; stop: () => void } {
  return { events: [], stop: () => {} };
}
