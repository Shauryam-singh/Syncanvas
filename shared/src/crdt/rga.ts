import type { Stamp } from './register.js';
import { compareStamps } from './register.js';

/**
 * Where a placement puts its object.
 *
 * The two stack ends are explicit origins rather than a `null` id, because
 * they mean different things to the RGA: a created object lands on **top** of
 * the stack, while `insertZOrder(objectId, null)` means "move to the
 * **bottom**" (the stage-1 contract), and both would otherwise share the
 * "root" slot.
 */
export type OrderOrigin =
  | { readonly kind: 'top' }
  | { readonly kind: 'bottom' }
  | { readonly kind: 'after'; readonly objectId: string };

/**
 * One placement of an object in the z-order sequence.
 *
 * The sequence is a replicated growable array (RGA): every object is a node,
 * and its origin is either the top of the stack (creation), the bottom of the
 * stack (reorder to back), or the object it was placed immediately after.
 *
 * An object has *one* current placement: a later placement replaces the
 * previous one, so moving an object around never leaves duplicates behind.
 */
export interface OrderEntry extends Stamp {
  readonly objectId: string;
  readonly origin: OrderOrigin;
}

/** Orders two placements: by version, so every replica sorts siblings alike. */
export function compareOrderEntries(a: OrderEntry, b: OrderEntry): -1 | 0 | 1 {
  return compareStamps(a, b);
}

/**
 * Merges one placement into the order map.
 *
 * Returns the input map untouched when the placement is not newer, so the
 * caller can keep structural sharing cheap.
 */
export function mergeOrderEntry(
  entries: ReadonlyMap<string, OrderEntry>,
  entry: OrderEntry,
): ReadonlyMap<string, OrderEntry> {
  const current = entries.get(entry.objectId);
  if (current && compareOrderEntries(current, entry) >= 0) return entries;
  const next = new Map(entries);
  next.set(entry.objectId, entry);
  return next;
}

export function mergeOrderEntries(
  entries: ReadonlyMap<string, OrderEntry>,
  incoming: ReadonlyMap<string, OrderEntry>,
): ReadonlyMap<string, OrderEntry> {
  let result = entries;
  for (const entry of incoming.values()) {
    result = mergeOrderEntry(result, entry);
  }
  return result;
}

/**
 * Materialises the sequence.
 *
 * A depth-first walk of the origin tree. The result depends only on the set of
 * entries — never on the order they arrived in — which is what makes the merge
 * commutative.
 *
 * The sibling rules are the ones a user expects from a layer list:
 *
 * - objects created on top are sorted **oldest first**, so the newest one is
 *   drawn last (on top);
 * - objects moved to the bottom are sorted **newest first**, so the most
 *   recent "send to back" really is the bottom-most;
 * - objects placed *after* another object are sorted **newest first**, so the
 *   most recent move lands immediately above its origin.
 *
 * Two details make the walk robust:
 *
 * - **Dead nodes stay as hinges.** A deleted object is skipped in the output
 *   but still walked, so the objects placed after it keep their relative
 *   position instead of collapsing to the bottom.
 * - **Cycles are broken deterministically.** A user can move A after B and B
 *   after A; the two placements then form a cycle with no natural root. The
 *   entries that the root walk never reached are emitted one component at a
 *   time, smallest version first, so every replica breaks the cycle the same
 *   way.
 */
export function orderOf(
  entries: ReadonlyMap<string, OrderEntry>,
  isAlive: (objectId: string) => boolean,
): string[] {
  const onTop: OrderEntry[] = [];
  const onBottom: OrderEntry[] = [];
  const children = new Map<string, OrderEntry[]>();

  for (const entry of entries.values()) {
    if (entry.origin.kind === 'top') {
      onTop.push(entry);
      continue;
    }
    if (entry.origin.kind === 'bottom') {
      onBottom.push(entry);
      continue;
    }

    const parentId = entry.origin.objectId;
    if (parentId === entry.objectId || !entries.has(parentId)) {
      // An unknown origin (or a self-edge) has nowhere else to go.
      onTop.push(entry);
      continue;
    }
    const siblings = children.get(parentId);
    if (siblings) siblings.push(entry);
    else children.set(parentId, [entry]);
  }

  onTop.sort(compareOrderEntries);
  onBottom.sort(compareOrderEntries).reverse();
  for (const siblings of children.values()) {
    siblings.sort(compareOrderEntries).reverse();
  }

  const emitted: string[] = [];
  const visited = new Set<string>();

  const walk = (initial: readonly OrderEntry[]): void => {
    const stack = [...initial].reverse();
    while (stack.length > 0) {
      const entry = stack.pop() as OrderEntry;
      if (visited.has(entry.objectId)) continue;
      visited.add(entry.objectId);
      if (isAlive(entry.objectId)) emitted.push(entry.objectId);
      const kids = children.get(entry.objectId);
      if (kids) {
        for (let index = kids.length - 1; index >= 0; index -= 1) {
          stack.push(kids[index] as OrderEntry);
        }
      }
    }
  };

  walk(onBottom);
  walk(onTop);

  // Anything left is part of a cycle (or hangs off one). Break it by taking
  // the smallest remaining entry and walking its component from there.
  const all = [...entries.values()].sort(compareOrderEntries);
  for (const entry of all) {
    if (visited.has(entry.objectId)) continue;
    walk([entry]);
  }

  return emitted;
}
