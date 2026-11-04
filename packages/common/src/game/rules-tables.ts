import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bodyAt, hex, uncommented } from './rules-source';

type Script = { name: string; text: string };
type Facts = { b: string; g?: number[] };

// The rules build's tables from single ServUO scripts (build-rules.ts): crafting stations, house and
// creature details, and the races' looks.
export function ruleTables(root: string, scripts: Script[], classes: Record<string, Facts>) {
  // The graphics a C# condition on an item ID holds for (`itemID == 4017 || (itemID >= 6522 && ...)`).
  const idsWhere = (condition: string, variable: string) => {
    const holds = new Function(variable, `return ${condition};`) as (id: number) => boolean;
    return Array.from({ length: 0x10000 }, (_, id) => id).filter(holds);
  };
  const scriptText = (path: string) => scripts.find(({ name }) => name.endsWith(path))?.text ?? '';
  // A class marked with an attribute ([Forge] class LargeForgeWest), and its own or inherited graphics.
  const marked = (attribute: string) =>
    [
      ...scripts.flatMap(({ text }) => [
        ...text.matchAll(new RegExp(`\\[${attribute}\\]\\s*(?:public\\s+)?class\\s+(\\w+)`, 'g'))
      ])
    ].flatMap((m) => {
      for (let at = m[1] ?? '', facts = classes[at]; facts; at = facts.b, facts = classes[at])
        if (facts.g) return facts.g;
      return [];
    });
  // Where smiths work and smelt: DefBlacksmithy.CheckAnvilAndForge's item and static conditions, and
  // Ore.cs IsForge; with the classes marked [Anvil] or [Forge].
  const blacksmithy = scriptText('Services/Craft/DefBlacksmithy.cs');
  const stationIds = (name: string) =>
    [
      ...new Set([
        ...[...blacksmithy.matchAll(new RegExp(`bool\\s+is${name}\\s*=\\s*([^;]+);`, 'g'))].flatMap((m) =>
          idsWhere((m[1] ?? '').replace(/type\.IsDefined\([^)]*\)/g, 'false').replace(/item\.ItemID/g, 'id'), 'id')
        ),
        ...marked(name)
      ])
    ].sort((a = 0, b = 0) => a - b);
  const smelting =
    /bool\s+IsForge\([\s\S]*?return\s+(\(itemID[^;]+);/.exec(scriptText('Items/Resource/Ore.cs'))?.[1] ?? 'false';
  // What cooking counts as heat (CraftItem.cs m_HeatSources: first and last graphic of each range).
  const heatRanges = hex(
    /m_HeatSources\s*=\s*\{([^}]*)\}/.exec(uncommented(scriptText('Services/Craft/Core/CraftItem.cs')))?.[1] ?? ''
  );
  const heat: number[] = [];
  for (let i = 0; i + 1 < heatRanges.length; i += 2)
    for (let id = heatRanges[i] ?? 0; id <= (heatRanges[i + 1] ?? -1); id++) heat.push(id);
  const stations = {
    anvils: stationIds('Anvil'),
    forges: stationIds('Forge'),
    smelting: [...new Set([...idsWhere(smelting, 'itemID'), ...marked('Forge')])].sort((a = 0, b = 0) => a - b),
    heat
  };
  // A list of first and last IDs (`m_Name = new int[] { first, last, ... }`), every ID in between.
  const spans = (text: string, list: string) => {
    const ends = hex(
      new RegExp(`${list}\\s*=\\s*(?:new\\s+int\\[\\]\\s*)?\\{([^}]*)\\}`).exec(uncommented(text))?.[1] ?? ''
    );
    const ids: number[] = [];
    for (let i = 0; i + 1 < ends.length; i += 2)
      for (let id = ends[i] ?? 0; id <= (ends[i + 1] ?? -1); id++) ids.push(id);
    return ids;
  };
  const baseCreature = scriptText('Mobiles/Normal/BaseCreature.cs');
  const keyTypes = new Map(
    [
      ...(/enum\s+KeyType\s*\{([^}]*)\}/.exec(scriptText('Items/Tools/Key.cs'))?.[1] ?? '').matchAll(
        /(\w+)\s*=\s*(0x[0-9a-f]+)/gi
      )
    ].map((m) => [m[1] ?? '', Number(m[2])])
  );
  const world = {
    // Land a house may not cover (HousePlacement.m_RoadIDs: roads, sand stones, furrows).
    roads: spans(scriptText('Multis/HousePlacement.cs'), 'm_RoadIDs'),
    // The keys a new house gives its owner (BaseHouse: new Key(KeyType.Gold)).
    houseKey: keyTypes.get(/new\s+Key\(\s*KeyType\.(\w+)/.exec(scriptText('Multis/BaseHouse.cs'))?.[1] ?? '') ?? 0,
    // What PackBodyPartOrBones puts in a creature's pack.
    bodyParts: [
      ...(/void\s+PackBodyPartOrBones\(\)([\s\S]*?)\n\s{8}\}/.exec(baseCreature)?.[1] ?? '').matchAll(
        /new\s+(\w+)\(\)/g
      )
    ].map((m) => m[1] ?? ''),
    // Everything fishing can bring up besides fish (Fishing.cs MutateEntry types).
    fished: [
      ...new Set(
        [...scriptText('Services/Harvest/Fishing.cs').matchAll(/new\s+MutateEntry\(([^;]*)\)/g)].flatMap((m) =>
          [...(m[1] ?? '').matchAll(/typeof\(\s*(\w+)\s*\)/g)].map((t) => t[1] ?? '')
        )
      )
    ]
  };
  const raceSource = uncommented(readFileSync(join(root, 'Scripts/Misc/RaceDefinitions.cs'), 'utf8'));
  // A method's body in a class body (`override <type> Name(...) { ... }`), its outer braces removed.
  const methodOf = (body: string, name: string) => {
    const at = new RegExp(`override\\s+\\w+\\s+${name}\\s*\\([^)]*\\)`).exec(body);
    if (!at) return undefined;
    const block = bodyAt(body, at.index);
    return block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
  };
  // The hues a race's random-hue method picks from: a Utility.Random(first, count) range, or one of its arrays.
  const huesOf = (body: string, method: string) => {
    const code = methodOf(body, method) ?? '';
    const range = /Utility\.Random\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(code);
    if (range) return Array.from({ length: Number(range[2]) }, (_, i) => Number(range[1]) + i);
    const array = /(m_\w+)\[/.exec(code)?.[1];
    const values = array && new RegExp(`${array}\\s*=\\s*new\\s+int\\[\\]\\s*\\{([^}]*)\\}`).exec(body)?.[1];
    return values ? hex(values) : [];
  };
  // The item IDs a race's ValidateHair / ValidateFacialHair accepts for each sex: the C# method body,
  // plain conditions and returns, run as JavaScript over the hair item IDs.
  const accepted = (body: string, method: string) => {
    const code = methodOf(body, method);
    if (!code) return { female: [] as number[], male: [] as number[] };
    const valid = new Function('female', 'itemID', code) as (female: boolean, itemID: number) => boolean;
    const ids = Array.from({ length: 0x4400 - 0x2000 }, (_, i) => 0x2000 + i);
    return { female: ids.filter((id) => valid(true, id)), male: ids.filter((id) => valid(false, id)) };
  };
  const races = [
    ...raceSource.matchAll(/base\(\s*raceID,\s*raceIndex,\s*"(\w+)",\s*"\w+",\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/g)
  ].map((match) => {
    const [, name = '', male, female, maleGhost, femaleGhost] = match;
    const body = bodyAt(raceSource, raceSource.lastIndexOf('class', match.index));
    return {
      name,
      male: Number(male),
      female: Number(female),
      maleGhost: Number(maleGhost),
      femaleGhost: Number(femaleGhost),
      hair: accepted(body, 'ValidateHair'),
      beards: accepted(body, 'ValidateFacialHair'),
      skins: huesOf(body, 'RandomSkinHue'),
      hairHues: huesOf(body, 'RandomHairHue')
    };
  });
  return { stations, world, races };
}
