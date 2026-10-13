/** A copy of `xs` with the item at `from` moved to position `to` (both clamped to the list). */
export function moveItem<T>(xs: readonly T[], from: number, to: number): T[] {
  const out = [...xs];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item as T);
  return out;
}
