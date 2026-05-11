import type { TupleRangeMs } from "../types.js";

export function randomDebounceMs([min, max]: TupleRangeMs): number {
  if (min >= max) return min;
  return min + Math.floor(Math.random() * (max - min));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
