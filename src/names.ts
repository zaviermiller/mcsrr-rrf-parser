// Optional human-readable names for the raw Minecraft 1.16.1 ids inside decoded records. The
// decoded `data` is never changed; names go into a separate `rec.names` object. Ids outside the
// vanilla tables resolve to null.
import { MC_DATA as MC } from './mc-data.ts';
import type { RecordNames, ReplayRecord } from './types.ts';

const R = MC.registries;
const E = MC.enums;
const INT_MIN = -2147483648;

const at = <T>(arr: readonly T[], i: number): T | null => (Number.isInteger(i) && i >= 0 && i < arr.length ? arr[i]! : null);
const item = (id: number) => at(R.item, id);
const potion = (id: number) => (id > 0 ? at(R.potion, id) : null);

// GameOptions.perspective (an int in 1.16.1).
const PERSPECTIVES = ['FIRST_PERSON', 'THIRD_PERSON_BACK', 'THIRD_PERSON_FRONT'] as const;

const BLOCK_FIRST_IDS = MC.blocks.map((b) => b[1]);

/** Number of block states in 1.16.1 (valid rawBlockState ids are 0 .. STATE_COUNT - 1). */
export const STATE_COUNT: number = (() => {
  const last = MC.blocks[MC.blocks.length - 1]!;
  return last[1] + (last[2] || []).reduce((n, [, values]) => n * values.length, 1);
})();

/** Block state id -> "name" or "name[prop=value,...]" (Block.STATE_IDS order: last property varies fastest). */
export function blockState(id: number): string | null {
  if (!Number.isInteger(id) || id < 0 || id >= STATE_COUNT) return null;
  let lo = 0;
  let hi = BLOCK_FIRST_IDS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (BLOCK_FIRST_IDS[mid]! <= id) lo = mid; else hi = mid - 1;
  }
  const [name, first, props] = MC.blocks[lo]!;
  if (!props) return name;
  let off = id - first;
  const parts = new Array<string>(props.length);
  for (let i = props.length - 1; i >= 0; i--) {
    const [prop, values] = props[i]!;
    parts[i] = `${prop}=${values[off % values.length]}`;
    off = Math.floor(off / values.length);
  }
  return `${name}[${parts.join(',')}]`;
}

/** Entity kind flags from mc_1_16_1.json (e.g. "living+villager" -> { living: true, villager: true }). */
function entityKind(typeName: string | null | undefined): Record<string, true> {
  const kind = typeName ? MC.entityKinds[typeName] : undefined;
  const flags: Record<string, true> = {};
  if (kind) for (const k of kind.split('+')) flags[k] = true;
  return flags;
}

export type EntityCustomDataNames = Pick<RecordNames, 'size' | 'baby' | 'mainHand' | 'fuse' | 'block' | 'boatType'>;

/** EntityAddTimeLine customData, interpreted like EntityAddTimeLine.execute (slime, living, tnt, falling block, boat). */
export function entityCustomData(typeName: string | null | undefined, customData: number): EntityCustomDataNames {
  const k = entityKind(typeName);
  if (k.slime) return { size: customData };
  if (k.living) {
    if (customData === INT_MIN) return { baby: true, mainHand: item(0) };
    return { baby: customData < 0, mainHand: item(Math.abs(customData)) };
  }
  if (k.tnt) return { fuse: customData };
  if (k.falling_block) return { block: blockState(customData) };
  if (k.boat) return { boatType: at(E.BoatType, customData) };
  return {};
}

export type MobStateNames = Pick<RecordNames, 'villagerType' | 'profession' | 'level' | 'color' | 'sheared' | 'angry'>;

/** MobStateTimeLine state for villager / sheep / enderman entities. */
export function mobState(typeName: string | null | undefined, state: number): MobStateNames {
  if (state === INT_MIN) return {};
  const k = entityKind(typeName);
  if (k.villager) {
    return {
      villagerType: at(R.villager_type, state & 0xFF),
      profession: at(R.villager_profession, (state >> 8) & 0xFF),
      level: state >> 16,
    };
  }
  if (k.sheep) return { color: at(E.DyeColor, state & 15), sheared: (state & 0x100) !== 0 };
  if (k.enderman) return { angry: (state & 1) !== 0 };
  return {};
}

function container(id: number): string | null {
  if (id === -1) return 'closed';
  if (id === -2) return 'inventory';
  return at(R.menu, id);
}

/** Per-player annotator; it remembers entity types so later records about an entity can be named. */
export class NameAnnotator {
  readonly entityTypes = new Map<number, string | null>();

  /** Returns the names object for a decoded record, or null when there is nothing to name. */
  annotate(rec: ReplayRecord): RecordNames | null {
    const n: RecordNames = {};
    switch (rec.type) {
      case 'PLAYER_POSE': n.pose = at(E.EntityPose, rec.data.pose); break;
      case 'PLAYER_PERSPECTIVE': n.perspective = at(PERSPECTIVES, rec.data.perspective); break;
      case 'PLAYER_EFFECT': n.effect = at(R.mob_effect, rec.data.effectId); break;
      case 'PLAYER_CONTAINER': n.container = container(rec.data.containerType); break;
      case 'BLOCK_UPDATE': n.block = blockState(rec.data.rawBlockState); break;
      case 'ENTITY_ADD': {
        const d = rec.data;
        const type = at(R.entity_type, d.entityTypeId);
        this.entityTypes.set(d.entityId, type);
        n.entityType = type;
        Object.assign(n, entityCustomData(type, d.customData));
        break;
      }
      case 'MOB_STATE': Object.assign(n, mobState(this.entityTypes.get(rec.data.entityId), rec.data.state)); break;
      case 'PIGLIN_STATE': n.offHand = item(rec.data.offHand); n.mainHand = item(rec.data.mainHand); break;
      case 'ITEM_ENTITY': {
        const d = rec.data;
        this.entityTypes.set(d.entityId, 'item');
        n.item = item(d.itemRawId);
        if (d.variant > 0) n.potion = potion(d.variant);
        break;
      }
      case 'PROJECTILE_ENTITY': {
        const d = rec.data;
        const type = at(R.entity_type, d.entityTypeId);
        this.entityTypes.set(d.entityId, type);
        n.entityType = type;
        if (d.potion > 0) n.potion = potion(d.potion);
        break;
      }
      case 'INVENTORY_SLOT': {
        const d = rec.data;
        const name = item(d.itemId);
        n.item = name;
        if (d.variant > 0) n.potion = potion(d.variant);
        if (d.enchantments.length) {
          // Suspicious stew stores its effects (effect raw id, seconds) in the enchantment slots.
          n.enchantments = name === 'suspicious_stew'
            ? d.enchantments.map((x) => ({ effect: at(R.mob_effect, x.id), seconds: x.level }))
            : d.enchantments.map((x) => ({ enchantment: at(R.enchantment, x.id), level: x.level }));
        }
        break;
      }
      case 'PIGLIN_BARTER': n.loot = rec.data.loot.map((x) => item(x.itemRawId)); break;
      case 'DRAGON_PHASE':
      case 'DRAGON_DEATH_PROGRESS':
      case 'DRAGON_PATH':
        n.phase = at(E.DragonPhase, rec.data.phase);
        break;
      default: break;
    }
    const d = rec.data as { entityId?: number; itemEntityId?: number; collectorId?: number };
    if (rec.type !== 'ENTITY_ADD' && rec.type !== 'PROJECTILE_ENTITY' && d.entityId !== undefined && this.entityTypes.has(d.entityId)) {
      n.entityType = this.entityTypes.get(d.entityId)!;
    }
    if (rec.type === 'ITEM_PICKUP') {
      if (this.entityTypes.has(d.itemEntityId!)) n.itemEntityType = this.entityTypes.get(d.itemEntityId!)!;
      if (this.entityTypes.has(d.collectorId!)) n.collectorType = this.entityTypes.get(d.collectorId!)!;
    }
    return Object.keys(n).length ? n : null;
  }
}
