export function clamp(value: number, min: number, max: number): number {
  if ([value, min, max].some(Number.isNaN) || min > max) throw new RangeError("Invalid range");
  return Math.max(min, Math.min(max, value));
}
