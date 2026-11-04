import type { Reader } from './reader';

// What an XmlSpawner placed in the world brings out: how many it keeps alive at once and each type it
// spawns with that type's maximum (ServUO XmlSpawner2.Serialize, version 31). Its name is the item's.
export interface SavedSpawner {
  count: number;
  // How far what it spawns may roam from it.
  homeRange: number;
  spawns: { type: string; max: number }[];
}

const strings = (r: Reader, n: number) => {
  for (let i = 0; i < n; i++) r.string();
};

// Reads XmlSpawner's own data after the base item. Undefined for any other version, or when keyword
// tags (scripted spawner state, never in `[createworld` spawners) make the rest unreadable here.
export function readXmlSpawner(r: Reader): SavedSpawner | undefined {
  if (r.int() !== 31) return undefined;
  r.skip(2); // DisableGlobalAutoReset, AllowNPCTriggering
  const n = r.int();
  r.skip(n * 4); // SpawnsPerTick
  r.skip(n * 4); // PackRange
  r.skip(n); // Disabled
  r.skip(1 + 8 + 8); // SpawnOnTrigger, FirstModified, LastModified
  r.skip(n * (1 + 1 + 8 + 8 + 8)); // RestrictKillsToSubgroup, ClearOnAdvance, MinDelay, MaxDelay, NextSpawn
  if (r.bool()) r.skip(r.int() * 4); // ShowBoundsItems
  r.skip(2); // IsInactivated, SmartSpawning
  r.string(); // SkillTrigger
  r.skip(4 + 1 + 4 + 8); // skill that triggered, FreeRun, mob who triggered, DespawnTime
  r.skip(n); // RequireSurface
  r.string(); // ConfigFile
  r.skip(2); // OnHold, HoldSequence
  strings(r, 2); // FirstModifiedBy, LastModifiedBy
  if (r.int() !== 0) return undefined; // keyword tags
  r.skip(1 + 4 + 8); // AllowGhostTriggering, SequentialSpawning, NextSeqReset
  r.skip(n * (4 + 8 + 4 + 4)); // SubGroup, SequentialResetTime, SequentialResetTo, KillsNeeded
  r.string(); // RegionName
  r.skip(2); // ExternalTriggering, ExternalTrigger
  strings(r, 2); // NoItemTriggerName, GumpState
  r.skip(4 + 4 + 1 + 4 + 4 + 8); // TOD mode, KillReset, skipped, spawncheck, SetPropertyItem, TriggerProbability
  strings(r, 6); // MobPropertyName, MobTriggerName, PlayerPropertyName, SpeechTrigger, ItemTriggerName, ProximityTriggerMessage
  r.skip(4); // ObjectPropertyItem
  r.string(); // ObjectPropertyName
  r.skip(4 + 4 + 4); // killcount, ProximityRange, ProximityTriggerSound
  r.skip(1); // proximity activated
  const duration = r.bool();
  const refractory = r.bool();
  r.skip(4 + 8 + 8 + 8 + 8); // StackAmount, TODStart, TODEnd, MinRefractory, MaxRefractory
  if (refractory) r.skip(8);
  if (duration) r.skip(8);
  r.skip(4 + 8); // ShowContainerStatic, Duration
  r.string(); // UniqueId
  r.skip(1); // HomeRangeIsRelative
  r.string(); // Name, unused: `[createworld` names the item
  r.skip(4 * 4 + 4 + 1 + 8 + 8); // X, Y, Width, Height, WayPoint, Group, MinDelay, MaxDelay
  const count = r.int();
  r.skip(4); // Team
  const homeRange = r.int();
  if (r.bool()) r.skip(8); // Running: time to the next spawn
  const spawns: SavedSpawner['spawns'] = [];
  for (let objects = r.int(); objects > 0; objects--) {
    const type = r.string() ?? '';
    const max = r.int();
    r.skip(r.int() * 4); // what it has out now
    spawns.push({ type, max });
  }
  return { count, homeRange, spawns };
}
