import type { SceneDoc } from './doc.js';

/**
 * Seed objects that used to be part of the room template but have been
 * retired. Existing rooms keep the old records in their snapshots, so loading
 * a room prunes the untouched copies.
 *
 * An object is only pruned when every part of it still carries the original
 * `seed:<id>` stamp. If somebody moved it, edited it or reordered it, the
 * record is real user state and is left alone.
 */
const RETIRED_SEED_IDS = ['demo-text'] as const;

export function pruneRetiredSeeds(doc: SceneDoc): SceneDoc {
  let changed = false;
  const objects = new Map(doc.objects);
  const order = new Map(doc.order);

  for (const id of RETIRED_SEED_IDS) {
    const record = objects.get(id);
    const placement = order.get(id);
    if (!record || !placement || record.death !== null || record.birth?.opId !== `seed:${id}`) {
      continue;
    }
    if (record.birth.hlc.wall !== 0) continue;
    if (placement.opId !== `seed:${id}` || placement.hlc.wall !== 0) continue;
    if (placement.origin.kind !== 'top') continue;

    const untouched = [...record.props.values()].every(
      (register) => register.opId === `seed:${id}` && register.hlc.wall === 0,
    );
    if (!untouched) continue;

    objects.delete(id);
    order.delete(id);
    changed = true;
  }

  return changed ? { ...doc, objects, order } : doc;
}
