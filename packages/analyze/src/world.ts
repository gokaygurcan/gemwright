import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Reader } from './reader';

// A ServUO pub57 world save read back offline: Saves/Mobiles and Saves/Items, each a type table
// (.tdb), an index (.idx: type, serial, offset, length per entity) and the data (.bin). Every
// entity's data starts with its base class (a script's Serialize calls base.Serialize first), so
// Mobile.Serialize and Item.Serialize are decoded for every entity; past them, only the few
// script types whose own data matters here (bank checks) are read.
export interface Mobile {
  serial: number;
  type: string;
  name?: string;
  title?: string;
  body: number;
  female: boolean;
  location: { x: number; y: number; z: number };
  map: number;
  online: boolean;
  // Skin hue, and hair and beard as ServUO keeps them (virtual items: graphic and hue).
  hue: number;
  hair?: { graphic: number; hue: number };
  beard?: { graphic: number; hue: number };
  statCap: number;
  followersMax: number;
  // Str, Dex, Int locks: 0 up, 1 down, 2 locked.
  statLocks: number[];
  str: number;
  dex: number;
  int: number;
  hits: number;
  stamina: number;
  mana: number;
  fame: number;
  karma: number;
  kills: number;
  deaths: number;
  criminal: boolean;
  access: number;
  guild: number;
  created: Date;
  skillCap: number;
  // Base values and caps in tenths, by skill index (SkillName); locks 0 up, 1 down, 2 locked.
  skills: number[];
  caps: number[];
  locks: number[];
  items: number[];
  player: boolean;
}

export interface Item {
  serial: number;
  type: string;
  graphic: number;
  hue: number;
  amount: number;
  layer: number;
  name?: string;
  parent?: number;
  location: { x: number; y: number; z: number };
  map: number;
  movable: boolean;
  stackable: boolean;
  blessedFor?: number;
  // A bank check's gold.
  worth?: number;
  // The ridden animal behind a mount item.
  mount?: number;
  // Where a teleporter sends whoever steps on it, and whether it is switched on.
  teleport?: { x: number; y: number; z: number; map: number; active: boolean };
  // Set when the record could not be decoded past its header (item sockets).
  partial?: boolean;
}

export interface World {
  mobiles: Map<number, Mobile>;
  items: Map<number, Item>;
  errors: { kind: string; serial: number; type: string; message: string }[];
}

interface Entry {
  type: string;
  serial: number;
  offset: number;
  length: number;
}

function readIndex(folder: string, name: string): { entries: Entry[]; data: Uint8Array } {
  const types = new Reader(readFileSync(join(folder, `${name}.tdb`)));
  const names = Array.from({ length: types.int() }, () => types.rawString());
  const index = new Reader(readFileSync(join(folder, `${name}.idx`)));
  const entries = Array.from({ length: index.int() }, () => ({
    type: names[index.int()] ?? '?',
    serial: index.int(),
    offset: Number(index.long()),
    length: index.int()
  }));
  return { entries, data: readFileSync(join(folder, `${name}.bin`)) };
}

const serials = (r: Reader) => Array.from({ length: r.int() }, () => r.int());

// Mobile.Serialize, version 37.
function readMobile(r: Reader, entry: Entry): Mobile {
  const version = r.int();
  if (version !== 37) throw new Error(`mobile version ${version}`);
  r.skip(1 + 4); // guild abbreviation, blood hue
  const deaths = r.int();
  r.skip(1 + 6 * 4 + 1); // guard immune, stat caps, slayer mechanics
  if (r.bool()) for (let n = r.int(); n > 0; n--) r.string();
  r.skip(1 + 3 * 8); // ignore mobiles, last stat gains
  const looks = r.byte();
  const virtual = () => {
    r.skip(4); // version
    return { graphic: r.int(), hue: r.int() };
  };
  const hair = looks & 0x01 ? virtual() : undefined;
  const beard = looks & 0x02 ? virtual() : undefined;
  if (looks & 0x04) r.skip(12); // face
  r.skip(1 + 4 + 4); // race, tithing, corpse
  const created = r.date();
  serials(r); // stabled
  r.skip(1); // can't walk
  r.skip(1); // virtues version
  const virtues = r.byte();
  for (let i = 0; i < 8; i++) if (virtues & (1 << i)) r.skip(4);
  r.skip(3 * 4); // thirst, BAC, short murders
  const followersMax = r.int();
  r.skip(4 + 4); // magic absorb, fealty
  const guild = r.int();
  r.skip(3 + 4 + 4 + 4 + 2); // title flags, holding, armor, sound, disarm/stun
  const statCap = r.int();
  r.skip(4 + 4); // name hue, hunger
  const location = r.point();
  const body = r.int();
  const name = r.string();
  r.string(); // guild title
  const criminal = r.bool();
  const kills = r.int();
  r.skip(4 * 4);
  r.string(); // language
  const female = r.bool();
  r.skip(3); // warmode, hidden, direction
  const hue = r.int();
  const [str, dex, int, hits, stamina, mana] = [r.int(), r.int(), r.int(), r.int(), r.int(), r.int()];
  const map = r.byte();
  r.skip(1);
  const [fame, karma] = [r.int(), r.int()];
  const access = r.byte();
  // Skills.Serialize, version 4.
  r.skip(4 + 4); // version, mastery
  const skillCap = r.int();
  const skills: number[] = [];
  const caps: number[] = [];
  const locks: number[] = [];
  for (let i = 0, n = r.int(); i < n; i++) {
    const flags = r.byte();
    if (flags === 0xff) {
      skills.push(0);
      caps.push(1000);
      locks.push(0);
      continue;
    }
    skills.push(flags & 0x1 ? r.short() : 0);
    caps.push(flags & 0x2 ? r.short() : 1000);
    locks.push(flags & 0x4 ? r.byte() : 0);
    if (flags & 0x8) r.int();
    if (flags & 0x10) r.long();
  }
  const items = serials(r);
  const player = r.bool();
  const title = r.string();
  r.string(); // profile
  r.skip(2); // profile locked, auto page notify
  // A logged-out character waits on the internal map; it comes back at its logout location.
  const logout = { location: r.point(), map: r.byte() };
  const statLocks = [r.byte(), r.byte(), r.byte()];
  const away = map === 127;
  return {
    serial: entry.serial,
    type: entry.type,
    name,
    title,
    body,
    female,
    location: away ? logout.location : location,
    map: away ? logout.map : map,
    online: !away,
    hue,
    hair,
    beard,
    statCap,
    followersMax,
    statLocks,
    str,
    dex,
    int,
    hits,
    stamina,
    mana,
    fame,
    karma,
    kills,
    deaths,
    criminal,
    access,
    guild,
    created,
    skillCap,
    skills,
    caps,
    locks,
    items,
    player
  };
}

// Each ItemSocket subclass's own data after the base (Scripts/Items/Internal/ItemSockets).
const SOCKETS: Record<string, (r: Reader) => void> = {
  Caddellite: (r) => r.skip(4),
  EnchantedHotItemSocket: (r) => r.skip(4 + 4),
  HonestyItemSocket: (r) => {
    r.skip(4);
    r.string();
    r.skip(4 + 8 + 1);
  },
  SearingWeapon: (r) => r.skip(4 + 1),
  SlayerSocket: (r) => r.skip(4 + 4)
};

// Item.Serialize, version 14, up to the parent: the compact SaveFlag layout.
function readItem(r: Reader, entry: Entry): Item {
  const version = r.int();
  if (version !== 14) throw new Error(`item version ${version}`);
  const item: Item = {
    serial: entry.serial,
    type: entry.type,
    graphic: 0,
    hue: 0,
    amount: 1,
    layer: 0,
    location: { x: 0, y: 0, z: 0 },
    map: 0x7f,
    movable: true,
    stackable: false
  };
  for (let sockets = r.int(); sockets > 0; sockets--) {
    const socket = r.string() ?? '';
    const rest = SOCKETS[socket];
    if (!rest) return { ...item, partial: true };
    r.skip(4 + 8); // ItemSocket version, expiry
    rest(r);
  }
  r.skip(1); // grid location
  const flags = r.int();
  r.encodedInt(); // minutes since last moved
  if (flags & 0x1) r.skip(1);
  if (flags & 0x08000000) r.skip(1);
  if (flags & 0x2 && r.bool()) {
    r.skip(1 + 12 + 12);
    r.int();
  }
  if (flags & 0x4) r.skip(1);
  if (flags & 0x8) item.location = { x: r.encodedInt(), y: r.encodedInt(), z: r.encodedInt() };
  else {
    if (flags & 0x00080000) item.location = { ...item.location, x: r.byte(), y: r.byte() };
    else if (flags & 0x00040000) item.location = { ...item.location, x: r.short(), y: r.short() };
    if (flags & 0x00020000) item.location.z = r.sbyte();
  }
  if (flags & 0x10) item.graphic = r.encodedInt();
  if (flags & 0x20) item.hue = r.encodedInt();
  if (flags & 0x40) item.amount = r.encodedInt();
  if (flags & 0x80) item.layer = r.byte();
  if (flags & 0x100) item.name = r.string();
  if (flags & 0x200) {
    const parent = r.int();
    if (parent !== -1) item.parent = parent;
  }
  if (flags & 0x400) serials(r); // contents, also known from each item's parent
  if (flags & 0x01000000) r.encodedInt();
  else if (flags & 0x800) r.skip(8);
  item.map = flags & 0x1000 ? r.byte() : 0x7f; // without the flag: the internal map
  // Visible and movable unless stated (ImplFlag: 0x02 movable, 0x08 stackable).
  const impl = flags & 0x00100000 ? r.encodedInt() : 0x03;
  item.movable = !!(impl & 0x02);
  item.stackable = !!(impl & 0x08);
  if (flags & 0x00200000) r.int(); // insured for
  if (flags & 0x00400000) {
    const owner = r.int();
    if (owner !== -1) item.blessedFor = owner;
  }
  if (flags & 0x00800000) r.int(); // held by
  if (flags & 0x02000000) r.encodedInt();
  // Script data after the base: BankCheck version, worth; MountItem version, mount.
  if (item.type === 'Server.Items.BankCheck' && r.int() === 0) item.worth = r.int();
  if (item.type === 'Server.Mobiles.MountItem' && r.int() === 0) item.mount = r.int();
  // Teleporter.Serialize, version 4: criminal and combat checks, source and destination effects,
  // delay (ticks), sound (encoded), creatures, active, destination point and map.
  if (item.type === 'Server.Items.Teleporter' && r.int() === 4) {
    r.skip(4 + 8);
    r.encodedInt();
    r.skip(1);
    const active = r.bool();
    const [x, y, z] = [r.int(), r.int(), r.int()];
    item.teleport = { x, y, z, map: r.byte(), active };
  }
  return item;
}

export function loadWorld(saves: string): World {
  const world: World = { mobiles: new Map(), items: new Map(), errors: [] };
  const load = <T>(kind: string, read: (r: Reader, e: Entry) => T, into: Map<number, T>) => {
    const { entries, data } = readIndex(join(saves, kind), kind);
    for (const entry of entries) {
      try {
        into.set(entry.serial, read(new Reader(data.subarray(entry.offset, entry.offset + entry.length)), entry));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        world.errors.push({ kind, serial: entry.serial, type: entry.type, message });
      }
    }
  };
  load('Mobiles', readMobile, world.mobiles);
  load('Items', readItem, world.items);
  return world;
}

// Accounts.xml: each account's characters by serial and its bank balance.
export function loadAccounts(saves: string) {
  const xml = readFileSync(join(saves, 'Accounts/accounts.xml'), 'utf8');
  return [...xml.matchAll(/<account>([\s\S]*?)<\/account>/g)].map(([, body = '']) => ({
    username: /<username>([^<]*)<\/username>/.exec(body)?.[1] ?? '',
    access: /<accessLevel>([^<]*)<\/accessLevel>/.exec(body)?.[1] ?? 'Player',
    lastLogin: /<lastLogin>([^<]*)<\/lastLogin>/.exec(body)?.[1],
    // Banked gold is an account balance in EJ (AccountGold), in units of CurrencyThreshold gold.
    gold: Math.round(Number(/<totalCurrency>([^<]*)<\/totalCurrency>/.exec(body)?.[1] ?? 0) * 1_000_000_000),
    characters: [...body.matchAll(/<char index="\d+">(\d+)<\/char>/g)].map(([, s]) => Number(s))
  }));
}
