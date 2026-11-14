import { gumpButtons } from '@gemwright/network/gumps';
import { Notoriety } from '@gemwright/network/opcodes';

import type { Spawner } from '../spawns';
import { reportedBankGold } from '../v1/bank-gold';
import type { Atlas, Place } from './atlas';
import { add, Beliefs, type Context, difference, empty, type Outcome, round } from './beliefs';
import { CareMemory } from './care-memory';
import { goods, honestly, usual, value, worth } from './choose';
import { consider, journeys } from './deliberate';
import type { Encounter } from './encounter';
import { Fight, motion } from './fight';
import type { HistoryEvent } from './history';
import { kindOf } from './inventory';
import { foreseeHarvest, foreseeTrade } from './knowledge';
import type { Locomotion } from './motion';
import type { Places } from './places';
import { Self } from './self';
import { Things } from './things';
import type { Traits } from './traits';
import { learnRoute, reachable } from './unreachable';
import { type Steps, Ventures } from './ventures';

// Verbs that move, look or toggle rather than try something.
// Notorieties of what does not fight: innocent, allied, invulnerable (ServUO Notoriety).
const peaceful = new Set([Notoriety.innocent, Notoriety.ally, Notoriety.invulnerable]);
const passing = new Set(['walk', 'war-mode', 'single-click', 'status-request', 'skill-lock', 'general']);
// Verbs that finish what the last one began: a target for a tool, a drop for a pick-up, a button.
const finishing = new Set(['target', 'drop', 'equip', 'gump-response', 'menu-response']);

type Data = Record<string, unknown>;

// What the resident tries and what comes of it. Each attempt (a verb on a recognised thing, with
// the target or drop that finishes it) is predicted from what the same attempt brought before, and
// what it brings is recorded against that prediction. Its beliefs are its whole history re-lived:
// replaying every past perception through the current mind, so what it has learned since about
// learning applies to all it has lived.
export class Mind {
  private readonly beliefs = new Beliefs();
  // What it is: its skills, stats and what they make it able to do (self.ts).
  readonly self = new Self();
  routeScope = '';
  readonly care = new CareMemory();
  private readonly fight = new Fight(this.self);
  // Awake it chooses; re-living its past it only learns (those choices are long made).
  awake = true;
  // Acting itself (live.ts), it chooses before it acts rather than beside another's acts.
  acting = false;
  private readonly ventures: Ventures;
  private readonly things = new Things();
  // Its health as it knows it (self.ts).
  private get health() {
    return this.self.health?.current ?? null;
  }
  private get maxHealth() {
    return this.self.health?.max ?? null;
  }
  private where: HistoryEvent['where'];
  private attempt?: {
    key: string;
    // The menu answers this attempt has made so far (each may open what the next one answers).
    replies?: { gump: number; button: number }[];
    // What the wiki foresees for this one attempt, when its key alone cannot say (a trade's prices,
    // a harvest's yield).
    foresight?: Partial<Outcome>;
    withdrawn?: boolean;
    looting?: boolean;
    // What it would have chosen itself when this attempt began.
    choice?: { key: string; value: number }[];
    object?: number;
    at: number;
    where: HistoryEvent['where'];
    health: number | null;
    // Damage another's blows did meanwhile: theirs, not the attempt's.
    harm: number;
    context: Context;
    outcome: Outcome;
  };
  // Who has been hurting it, and how much, since it last died or woke.
  private harmed?: { by: number; amount: number };

  constructor(
    private readonly resident: string,
    private readonly record: (event: HistoryEvent) => void,
    private readonly born: Traits,
    spawners: readonly Spawner[] = [],
    // The skills of its trade (its template's primary skills): what it lives by.
    trade: readonly string[] = [],
    public supporting: readonly string[] = []
  ) {
    this.trade = trade.length ? new Set(trade) : undefined;
    this.ventures = new Ventures(spawners, (visit) => this.write('visited', visit));
    this.traits = { ...born };
  }
  private readonly traits: Traits;
  private readonly trade?: ReadonlySet<string>;
  // The skills of its trade, as given.
  get tradeSkills(): readonly string[] {
    return [...(this.trade ?? [])];
  }
  // How many times it has put things in its bank box.
  private deposits = 0;
  bankGold?: number;
  guarded?: boolean;
  // Where it is (atlas.ts), as of its last step; the map it reads that from.
  here?: Place;
  atlas?: Atlas;
  // Where things were seen, and how long each kind stays (places.ts).
  places?: Places;
  // Where it may be at all (gemwright.json ai.cities, atlas.ts `within`): anywhere until told.
  allowed: (p: { x: number; y: number }) => boolean = () => true;
  // The box every place it may go lies in, when it is kept to some cities.
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  private readonly missingSpells = new Set<number>();
  // How far what came of its attempts has surprised it, for each trait that weighs a part of it, over
  // the attempts where that part was expected or came: surviving more than it feared makes it bolder,
  // gold and skill beyond what it hoped greedier and more diligent. Each trait drifts from the one it
  // was born with by the mean surprise, the core counted as one more attempt that surprised it not at
  // all, so one whose expectations come true stays as it was.
  private readonly surprised = new Map<'boldness' | 'greed' | 'diligence', { n: number; sum: number }>();

  snapshot() {
    return {
      beliefs: this.beliefs.snapshot(),
      fight: this.fight.snapshot(),
      self: this.self.snapshot(),
      care: { ...this.care },
      supporting: this.supporting,
      things: this.things.snapshot(),
      ventures: this.ventures.snapshot(),
      where: this.where,
      attempt: this.attempt,
      harmed: this.harmed,
      traits: this.traits,
      deposits: this.deposits,
      bankGold: this.bankGold,
      guarded: this.guarded,
      here: this.here,
      missingSpells: this.missingSpells,
      surprised: this.surprised,
      revision: this.revision,
      refusedDrops: this.refusedDrops,
      unworn: this.unworn,
      menus: this.menus,
      roots: this.roots,
      links: this.links,
      targetTools: this.targetTools,
      probed: this.probed,
      prices: this.prices
    };
  }

  restore(snapshot: ReturnType<Mind['snapshot']>) {
    // Health is what it is (self.ts); a checkpoint from before kept it here.
    const { beliefs, fight, self, care, things, ventures, ...rest } = snapshot;
    if (care) Object.assign(this.care, care);
    const {
      health: _health,
      maxHealth: _maxHealth,
      ...state
    } = rest as typeof rest & {
      health?: unknown;
      maxHealth?: unknown;
    };
    this.beliefs.restore(beliefs);
    if (self) this.self.restore(self);
    this.fight.restore(fight);
    this.things.restore(things);
    this.ventures.restore(ventures);
    Object.assign(this, state);
  }

  revision = 0;
  // Changes that bear on a plan in progress (matters()): what makes it think again on the way.
  noticed = 0;
  // The creatures in view whose coming it noticed.
  private readonly creatures = new Set<number>();
  // The kind of the last event that made its picture of the world change (`revision`).
  changedBy = '';
  private readonly refusedDrops = new Map<number, { amount: number | undefined; place: string }>();
  // What its tools answered when it tried them, as a player learns a tool's menus: every menu the
  // shard opened (its serial, id and reply buttons), the menu each tool opens, and which button of
  // which menu opens what next — the whole interaction chain, its branches and its ways back. Also
  // the tools whose use asked for a target instead, and those that answered with nothing.
  private readonly menus: Record<string, { gump: number; buttons: number[] }> = {};
  private readonly roots: Record<string, string> = {};
  private readonly links: Record<string, string> = {};
  private readonly targetTools = new Set<string>();
  private readonly probed = new Set<string>();
  // What the shard's vendors were last seen to pay for each thing (their sell lists, read whenever
  // it sells): what the market pays for what it brings, rather than what the wiki says it is worth.
  private readonly prices: Record<string, number> = {};
  // How often the market's prices changed, and what it last knew it had (has()), with what that
  // knowing was built on.
  private priced = 0;
  private held?: { key: string; value: ReturnType<Mind['inventory']> };

  // What a thing is worth to it now: what the market last paid for it, or its worth until then.
  price = (name: string) => {
    for (const type of name.split('/')) {
      const paid = this.prices[type];
      if (paid !== undefined) return paid;
    }
    return worth(name);
  };

  // The thing of the plain use still open — a tool of its own, or a person — if that is what a menu
  // or a cursor answers.
  private openTool() {
    return /^double-click (?:my )?(.+)$/.exec(this.attempt?.key ?? '')?.[1];
  }

  // What a person calls itself, as its client's name answer said (a person is a Person; Marcy is
  // Marcy), and what its attempts and beliefs are kept under.
  label(serial: number) {
    return this.things.labels.get(serial);
  }

  canDrop(serial: number) {
    const refused = this.refusedDrops.get(serial);
    return (
      !refused ||
      refused.amount !== this.things.owned.get(serial)?.amount ||
      refused.place !== JSON.stringify(this.where)
    );
  }

  // Whether an event changes what a plan in progress is worth: its own things, its health, a blow or a
  // spell, a creature coming or going, where it is. People and vendors coming into view tell it
  // nothing new (it knows where vendors stand and what they trade), nor do things lying about.
  private matters(kind: string, data: Data, health: number | undefined) {
    const person = (names: string | string[] | undefined) =>
      (Array.isArray(names) ? names : (names?.split('/') ?? [])).includes('Person');
    switch (kind) {
      case 'gained':
      case 'lost':
      case 'listed':
      case 'missing':
      case 'damage':
      case 'died':
      case 'death':
      case 'care':
      case 'stranded':
      case 'route-failed':
      case 'drop-refused':
      case 'wear-refused':
      case 'resource-spent':
        return true;
      case 'self':
        return (health !== undefined && this.health !== null && health < this.health) || data.poison !== undefined;
      // Another kind of place, guarded or not, or other land: not one shop of a town for the next.
      case 'place':
        return (
          !this.here ||
          this.here.kind !== data.kind ||
          this.here.guarded !== data.guarded ||
          this.here.land !== data.land ||
          this.here.map !== data.map
        );
      case 'swing':
        return data.target === this.things.self;
      case 'animated':
        return data.serial !== this.things.self && motion(data) !== undefined;
      // A creature that may fight or be fought: not a person, nor one innocent, allied or
      // invulnerable (a tame horse, a pet). Its leaving matters as its coming did.
      case 'seen':
      case 'revealed':
        if (
          data.kind !== 'mobile' ||
          data.serial === this.things.self ||
          person(data.is as string[]) ||
          peaceful.has(data.notoriety as number)
        )
          return false;
        this.creatures.add(data.serial as number);
        return true;
      case 'gone':
        return this.creatures.delete(data.serial as number);
      default:
        return false;
    }
  }

  // What the shard would not let it wear (an item of another race, too heavy for its hands): never
  // offered to be put on again.
  private readonly unworn = new Set<number>();
  wears(serial: number) {
    return !this.unworn.has(serial);
  }

  refuseDrop(serial: number) {
    this.revision++;
    const refusal = { serial, amount: this.things.owned.get(serial)?.amount, place: JSON.stringify(this.where) };
    this.refusedDrops.set(serial, refusal);
    this.write('drop-refused', refusal);
  }

  observe(event: HistoryEvent) {
    const data = event.data as Data;
    const health = data.health as { current?: number } | undefined;
    if (this.matters(event.kind, data, health?.current)) {
      this.noticed++;
      this.changedBy = event.kind;
    }
    if (
      (event.kind === 'self' &&
        ((health?.current !== undefined && health.current !== this.health) ||
          Object.keys(data).some((key) => ['weight', 'attributes', 'poison', 'map', 'gold', 'mana'].includes(key)))) ||
      (event.kind === 'swing' && data.target === this.things.self) ||
      [
        'care',
        'stranded',
        'route-failed',
        'awake',
        'died',
        'death',
        'damage',
        'skill',
        'gained',
        'lost',
        'seen',
        'revealed',
        'gone',
        'resource-spent',
        'drop-refused',
        'listed',
        'missing'
      ].includes(event.kind) ||
      (event.kind === 'changed' && Object.keys(data).some((key) => !['serial', 'x', 'y', 'z'].includes(key)))
    )
      this.revision++;
    this.where = event.where ?? this.where;
    this.fight.observe(event, (serial) => this.things.names.get(serial));
    this.self.observe(event);
    this.care.observe(event);
    learnRoute(event, this.routeScope);
    const outcome = this.attempt?.outcome;
    switch (event.kind) {
      case 'care':
        if (data.action === 'spell-known') this.missingSpells.delete(Number(data.spell));
        this.things.observe(event, outcome, this.attempt);
        break;
      case 'training':
        this.supporting = data.skills as string[];
        break;
      case 'wear-refused':
        this.revision++;
        this.unworn.add(Number(data.serial));
        break;
      case 'drop-refused':
        this.refusedDrops.set(Number(data.serial), {
          amount: data.amount as number | undefined,
          place: String(data.place)
        });
        break;
      case 'movement':
        this.beliefs.moved(String(data.key), Number(data.steps), Number(data.seconds), Number(data.stamina));
        break;
      case 'resource-spent':
        this.beliefs.exhaust(
          data as { x: number; y: number; width: number; height: number },
          Number(data.until),
          event.at
        );
        break;
      case 'executed':
        this.beliefs.executed(String(data.id), data.succeeded === true);
        break;
      case 'awake': {
        this.guarded = undefined;
        // A session that ended without sleep (a crash) left its last attempt unfinished: unknowable.
        this.attempt = undefined;
        this.harmed = undefined;
        this.things.wake(data.serial as number);
        break;
      }
      case 'asleep':
        // Gone mid-attempt, it never saw how it ended: nothing to learn from it.
        this.attempt = undefined;
        this.ventures.leave();
        break;
      case 'acted':
        if (data.verb === 'walk') this.ventures.walk(event.at, event.where);
        this.act(data, event.at);
        break;
      // A menu opened, whether from a tool's use or from answering a button: its buttons are
      // recorded, and what opened it — the tool, or which button of which menu — so the chain that
      // led here stays known, branches and ways back included.
      case 'gump': {
        const opened = data.value as { serial?: number; id?: number; layout?: string } | undefined;
        if (
          opened &&
          typeof opened.serial === 'number' &&
          typeof opened.id === 'number' &&
          typeof opened.layout === 'string'
        ) {
          // A menu is known by what it is (its gump id), never by one opening of it: the shard gives
          // every opening a serial of its own, and what its buttons lead to stays the same.
          const menu = String(opened.id);
          const buttons = gumpButtons(opened.layout);
          if (buttons.length) this.menus[menu] = { gump: opened.id, buttons };
          const reply = this.attempt?.replies?.at(-1);
          if (reply) this.links[`${reply.gump} ${reply.button}`] = menu;
          else {
            const tool = this.openTool();
            if (tool) this.roots[tool] = menu;
          }
        }
        break;
      }
      // A tool whose use asked for a target rather than opening a menu: it works on something the
      // client shows it, not through a list.
      case 'screen':
        if (data.key === 'cursor' && data.value) {
          const tool = this.openTool();
          if (tool) this.targetTools.add(tool);
        }
        break;
      // A vendor's sell list: what it pays for the goods offered to it, which is what those goods
      // are worth to the mind from then on.
      case 'sell': {
        const offers = data.value as { serial?: number; price?: number }[] | undefined;
        if (Array.isArray(offers))
          for (const offer of offers) {
            if (typeof offer.serial !== 'number' || typeof offer.price !== 'number' || offer.price <= 0) continue;
            const thing = this.thing(offer.serial);
            if (!thing?.startsWith('my ')) continue;
            for (const type of thing.slice(3).split('/')) this.prices[type] = offer.price;
            this.priced++;
          }
        break;
      }
      case 'place':
        this.here = data as unknown as Place;
        this.guarded = this.here.guarded;
        this.revision++;
        break;
      case 'self': {
        if ('map' in data) this.guarded = undefined;
        break;
      }
      case 'spell-missing':
        this.missingSpells.add(Number(data.spell));
        break;
      case 'skill':
        if (outcome && data.before !== null) {
          outcome.skill += (data.value as number) - (data.before as number);
          add(outcome.skills, String(data.skill), (data.value as number) - (data.before as number));
        }
        break;
      case 'seen':
      case 'revealed':
      case 'gained':
      case 'changed':
      case 'lost':
      case 'gone':
      case 'listed':
      case 'missing':
        this.things.observe(event, outcome, this.attempt);
        if (this.things.mobiles.has(data.serial as number) && typeof data.x === 'number' && typeof data.y === 'number')
          this.ventures.saw(this.things.names.get(data.serial as number) ?? '', data.x, data.y);
        break;
      case 'heard': {
        if (data.cliloc === 500112 || data.cliloc === 500113) {
          this.guarded = data.cliloc === 500112;
          // The shard is right about its guards; where the map said otherwise, that is noted.
          if (this.here && this.here.guarded !== this.guarded)
            this.write('place-disagreed', { regions: this.here.regions, map: this.here.guarded, shard: this.guarded });
          this.revision++;
        }
        const balance = reportedBankGold(Number(data.cliloc), String(data.arguments ?? ''));
        if (balance !== undefined) {
          this.bankGold = balance;
          this.revision++;
        }
        // Its own attempts' system messages, and what whoever it addressed answers back, are what
        // came of them: a reply is part of the outcome of the attempt it answers.
        if (outcome && (data.name === 'System' || data.serial === 0xffffffff || data.serial === this.attempt?.object))
          add(outcome.heard, String(data.cliloc ?? data.text), 1);
        // A vendor paid from the bank says what it took (ServUO BaseVendor): gold that never left the pack.
        const paid = /(\d+) gold, which has been withdrawn from your bank/.exec(String(data.text ?? ''));
        if (paid && data.serial === this.attempt?.object) {
          if (outcome) add(outcome.lost, 'Gold', Number(paid[1]));
          if (this.bankGold !== undefined) this.bankGold = Math.max(0, this.bankGold - Number(paid[1]));
        }
        // A banker's "Thou hast withdrawn gold from thy account" (ServUO Banker, 1010005): the gold
        // handed over was already its own.
        if (data.cliloc === 1010005) {
          if (this.attempt) this.attempt.withdrawn = true;
          this.bankGold = undefined;
        }
        break;
      }
      case 'death':
        if (outcome && data.serial === this.attempt?.object) outcome.killed = 1;
        this.things.observe(event, outcome, this.attempt);
        break;
      case 'damage': {
        const by = this.fight.blamed;
        if (Number(data.key) !== this.things.self || by === undefined || by === this.attempt?.object) break;
        const amount = (data.value as { amount: number }).amount;
        if (this.attempt) this.attempt.harm += amount;
        this.harmed = { by, amount: (this.harmed?.by === by ? this.harmed.amount : 0) + amount };
        break;
      }
      case 'died': {
        this.things.diedAt = this.where;
        const harmed = this.harmed;
        if (!harmed) {
          if (outcome) outcome.died = 1;
          break;
        }
        // Killed by another: the death, and what it leaves behind, are an episode of their own.
        this.finish(event.at);
        this.harmed = undefined;
        this.attempt = {
          key: `struck by ${this.things.names.get(harmed.by) ?? 'unknown'}`,
          object: harmed.by,
          at: event.at,
          where: this.where,
          health: null,
          harm: 0,
          context: this.context(harmed.by),
          outcome: { ...empty(), health: -harmed.amount, died: 1 }
        };
        break;
      }
    }
  }

  private thing(serial: unknown) {
    return this.things.thing(serial);
  }

  private act(data: Data, at: number) {
    const verb = data.verb as string;
    // Walking away ends what it was doing, unless it is chasing what it fights.
    if (verb === 'walk' && this.attempt && !this.attempt.key.startsWith('attack ')) this.finish(at);
    // An emote (speech type 2) expresses rather than tries anything.
    if (passing.has(verb) || (verb === 'speech' && data.type === 2)) return;
    if (verb === 'pick-up') this.things.lift(data.serial as number, data.amount as number | undefined);
    if (verb === 'drop' && typeof data.container === 'number' && this.things.inBank(data.container)) {
      this.deposits++;
      if (
        this.things.owned
          .get(data.serial as number)
          ?.name.split('/')
          .includes('Gold')
      )
        this.bankGold = undefined;
    }
    // Opening the corpse of what it killed and taking from it is still that fight: what it takes is
    // what the fight brought.
    const attempt = this.attempt;
    if (attempt?.key.startsWith('attack ') && attempt.outcome.killed) {
      const on = this.thing(data.serial) ?? '';
      if (on.includes('Corpse of ') || (attempt.looting && (verb === 'pick-up' || verb === 'drop'))) {
        attempt.looting = true;
        return;
      }
    }
    if (finishing.has(verb) && this.attempt) {
      const on =
        verb === 'gump-response'
          ? `${data.gump}:${data.button}`
          : verb === 'drop'
            ? (this.thing(data.container) ?? 'ground')
            : (this.thing(data.serial) ??
              (data.graphic ? `tile${data.graphic}` : data.land !== undefined ? `land${data.land}` : 'land'));
      this.attempt.key += ` > ${verb} ${on}`;
      if (verb === 'gump-response') {
        const reply = { gump: Number(data.gump), button: Number(data.button) };
        this.attempt.replies = [...(this.attempt.replies ?? []), reply];
      }
      this.attempt.context = this.context(this.attempt.object, this.attempt.key);
      const tool = /^double-click my (.+)$/.exec(this.attempt.key.split(' > ')[0] ?? '')?.[1];
      if (verb === 'target' && tool && !data.serial)
        this.attempt.foresight = foreseeHarvest(
          tool,
          data.graphic ? { tile: data.graphic as number } : { land: data.land as number | undefined },
          (skill) => this.self.skill(skill)
        );
      this.predict();
      return;
    }
    this.finish(at);
    const object = [data.serial, data.vendor].find((serial) => typeof serial === 'number') as number | undefined;
    // Addressed, a person is named by what it calls itself, so what it learns of one person is that
    // person's alone. Trades and the rest keep naming a mobile by what kind of thing it is.
    const named =
      verb === 'double-click' && object !== undefined && this.things.mobiles.has(object)
        ? this.label(object)
        : undefined;
    let on =
      named ??
      this.thing(object) ??
      (verb === 'text-command' ? String(data.command) : verb === 'speech' ? String(data.text) : '');
    let foresight: Partial<Outcome> | undefined;
    if ((verb === 'buy' || verb === 'sell') && Array.isArray(data.items)) {
      const items = (data.items as { serial: number; amount: number }[]).map(({ serial, amount }) => ({
        name: this.things.owned.get(serial)?.name ?? this.things.names.get(serial) ?? 'unknown',
        amount
      }));
      foresight = foreseeTrade(verb, on, items);
      on += `: ${items
        .map((item) => `${item.amount} ${item.name}`)
        .sort()
        .join(', ')}`;
    }
    this.attempt = {
      key: on ? `${verb} ${on}` : verb,
      foresight,
      choice: this.awake && !this.acting ? this.consider() : undefined,
      object,
      at,
      where: this.where,
      health: this.health,
      harm: 0,
      context: this.context(object, on ? `${verb} ${on}` : verb),
      outcome: empty()
    };
    this.predict();
  }

  // What it expects from an attempt: its own past attempts, and the wiki's foresight (a fight, a
  // trade) counted as one more attempt, so it guides the first tries and fades as experience grows.
  private expected(key: string, foresight?: Partial<Outcome>, context = this.context()) {
    const foreseen =
      foresight ??
      (key.startsWith('attack ') && !key.includes(' > ')
        ? this.fight.foresee(key.slice(7), this.health, context.its)
        : undefined);
    return this.beliefs.expect(key, context, foreseen);
  }

  // Its situation now, relative to itself: how healthy, how laden, how many creatures about, and how
  // hurt what it acts on is.
  private context(object?: number, key?: string): Context {
    const carried = [...this.things.owned].reduce(
      (sum, [serial, item]) => sum + (this.things.inBank(serial) ? 0 : worth(item.name) * item.amount),
      0
    );
    const creatures = [...this.things.mobiles].filter((serial) =>
      this.fight.isCreature(this.things.names.get(serial))
    ).length;
    const its = object === undefined ? undefined : this.things.healths.get(object);
    const trained = key && this.beliefs.trains(key);
    return {
      ...(this.health !== null && this.maxHealth ? { health: round(this.health / this.maxHealth) } : {}),
      carried: round(Math.log1p(carried)),
      creatures,
      ...(its === undefined ? {} : { its: round(its) }),
      ...(trained ? { skill: this.self.skill(trained) } : {})
    };
  }

  private predict() {
    if (!this.attempt) return;
    const { n, alike, foreseen, outcome } = this.expected(
      this.attempt.key,
      this.attempt.foresight,
      this.attempt.context
    );
    this.write('predicted', {
      key: this.attempt.key,
      n,
      alike,
      ...(foreseen ? { foreseen } : {}),
      ...(outcome ? { expect: outcome } : {})
    });
  }

  private finish(at: number) {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = undefined;
    // A tool — or a person — used on its own that answered with nothing: no point trying again.
    const tool = /^double-click (?:my )?(.+)$/.exec(attempt.key)?.[1];
    if (tool && !this.roots[tool]) this.probed.add(tool);
    const observed = attempt.outcome;
    observed.seconds = round((at - attempt.at) / 1000);
    if (attempt.where && this.where) {
      observed.crossed = attempt.where.map === this.where.map ? 0 : 1;
      observed.moved = observed.crossed
        ? 0
        : Math.max(Math.abs(this.where.x - attempt.where.x), Math.abs(this.where.y - attempt.where.y));
    }
    if (attempt.health !== null && this.health !== null) observed.health = this.health - attempt.health + attempt.harm;
    if (attempt.withdrawn && observed.gained.Gold) add(observed.lost, 'Gold', observed.gained.Gold);
    const { n, outcome } = this.expected(attempt.key, attempt.foresight, attempt.context);
    if (outcome) {
      // Surprise in a part against all of it there was, counting what an attempt usually brings,
      // so each lies between -1 and 1 and a miss on a trifle is a trifle.
      const usually = usual([this.beliefs.lived], this.trade);
      const span = this.beliefs.lived.seconds / (this.beliefs.attempts || 1);
      const relative = (seen: number, expected: number, rate: number) =>
        seen || expected ? (seen - expected) / (Math.abs(seen) + Math.abs(expected) + rate * span) : undefined;
      this.drift(attempt.key, 'boldness', outcome.died || observed.died ? outcome.died - observed.died : undefined);
      this.drift(attempt.key, 'greed', relative(goods(observed), goods(outcome), usually.gold));
      this.drift(attempt.key, 'diligence', relative(observed.skill, outcome.skill, usually.skill));
    }
    if (attempt.choice)
      this.write('considered', {
        doing: attempt.key,
        choice: attempt.choice[0]?.key,
        agrees: attempt.choice[0]?.key === attempt.key,
        options: attempt.choice.slice(0, 5)
      });
    this.write('outcome', {
      key: attempt.key,
      context: attempt.context,
      observed,
      n,
      ...(outcome ? { error: difference(observed, outcome) } : {})
    });
    const rates = usual([this.beliefs.lived], this.trade);
    const carried = [...this.things.owned].reduce(
      (sum, [serial, item]) => sum + (this.things.inBank(serial) ? 0 : worth(item.name) * item.amount),
      0
    );
    this.beliefs.learn(attempt.key, attempt.context, observed, (o) =>
      value(o, this.traits, rates, carried, this.trade, this.price)
    );
    this.ventures.remember(attempt.key, attempt.where);
  }

  private drift(cause: string, trait: 'boldness' | 'greed' | 'diligence', surprise: number | undefined) {
    if (surprise === undefined) return;
    const so = this.surprised.get(trait) ?? { n: 0, sum: 0 };
    so.n++;
    so.sum += surprise;
    this.surprised.set(trait, so);
    const to = round(Math.min(1, Math.max(0, this.born[trait] + so.sum / (so.n + 1))));
    if (to === this.traits[trait]) return;
    this.traits[trait] = to;
    this.write('drifted', { trait, to, cause });
  }

  // What it could do right now and how much each serves its life goal, best first: the attempts it
  // knows whose object is at hand, attacking a creature in view, or resting.
  // What an attempt is worth to it now, from its own past and the wiki's foresight; how many times
  // it has tried it. Nothing when it can neither remember nor foresee what it brings.
  appraise(key: string, foresight?: Partial<Outcome>, object?: number) {
    const { n, outcome } = this.expected(key, foresight, this.context(object, key));
    if (!outcome) return undefined;
    const carried = [...this.things.owned].reduce(
      (sum, [serial, item]) => sum + (this.things.inBank(serial) ? 0 : worth(item.name) * item.amount),
      0
    );
    const rates = usual([this.beliefs.lived], this.trade);
    const worthOf = (o: Outcome) =>
      value(honestly(key, o, this.traits), this.traits, rates, carried, this.trade, this.price);
    const expected = worthOf(outcome);
    // What the wiki promises beyond what its few tries have shown, hoped for as far as it is curious
    // and as little as it has tried.
    const promised = foresight && n ? worthOf({ ...empty(), ...foresight }) : expected;
    const hope = (this.traits.curiosity * Math.max(0, promised - expected)) / (n + 1);
    return { n, seconds: outcome.seconds, value: round(expected + hope), outcome };
  }

  get locomotion(): Locomotion {
    return {
      experience: (key) => this.beliefs.movement(key),
      curiosity: this.traits.curiosity,
      observed: (key, steps, seconds, stamina) => {
        this.beliefs.moved(key, steps, seconds, stamina);
        this.write('movement', { key, steps, seconds, stamina });
      }
    };
  }

  availability(x: number, y: number) {
    return this.beliefs.availability(`${x},${y}`);
  }

  exhausted(bank: { x: number; y: number; width: number; height: number; respawn: number }) {
    const until = Date.now() + bank.respawn;
    this.beliefs.exhaust(bank, until);
    this.write('resource-spent', { ...bank, until });
  }

  chance(id: string) {
    return this.beliefs.chance(id);
  }

  complete(id: string, succeeded: boolean) {
    const at = Date.now();
    this.finish(at);
    this.beliefs.executed(id, succeeded);
    this.write('executed', { id, succeeded }, at);
  }

  notice(kind: string, data: object) {
    const event = { resident: this.resident, at: Date.now(), kind, data, ...(this.where ? { where: this.where } : {}) };
    this.observe(event);
    this.record({ ...event, via: 'noticed' });
  }

  reachable(goal: { x: number; y: number; z?: number }) {
    return !this.where || reachable(this.where, goal, Date.now(), this.routeScope);
  }

  // What it calls a thing in view, its own things, its skills and traits: what its hands work with.
  // Where it stands, as of what it last perceived.
  get position() {
    return this.where;
  }
  get serial() {
    return this.things.self;
  }
  // What is on its screen now, one thing or all (things.ts).
  sight(serial: number) {
    return this.things.sight(serial);
  }
  sights() {
    return this.things.sights();
  }
  // Whether a thing of its own is on its person now (worn or in its pack).
  carrying(serial: number) {
    return this.things.carrying(serial);
  }
  // Its backpack and bank box, by serial, as worn.
  get pack() {
    return this.things.worn(21);
  }
  get bankCapacity() {
    const box = this.bankBox;
    const contents = box === undefined ? undefined : this.described(box)?.contents;
    return { count: Math.max(this.has().bank.length, contents?.count ?? 0), max: contents?.max ?? 125 };
  }
  get bankBox() {
    return this.things.worn(29);
  }
  deathRobe(serial: number) {
    return this.things.deathRobe(serial);
  }
  get riding() {
    return this.things.riding();
  }
  call(serial: number) {
    return this.thing(serial);
  }
  // Everything it has, by where it is and of what kind, each with what it is worth and weighs:
  // worn and in its pack as they are now, its bank as last seen, the ground and corpses about it.
  // What it wears, carries, banks, and sees lying about or in corpses. Built again only when its
  // picture of the world changed (anything gained, lost or moved), it stands elsewhere, prices
  // moved, or a second passed (things out of sight fade); every change shows at the next ask.
  has() {
    const at = this.where;
    const key = `${this.revision}|${at?.x},${at?.y},${at?.z},${at?.map}|${this.priced}|${Math.floor(Date.now() / 1000)}`;
    if (this.held?.key !== key) this.held = { key, value: this.inventory() };
    return this.held.value;
  }

  private inventory() {
    const view = this.things.has(this.where, 18);
    const tag = <T extends { serial: number; name: string; amount: number }>(item: T) => ({
      ...item,
      kind: kindOf(item.name),
      worth: this.price(item.name) * item.amount,
      weight: this.things.described.get(item.serial)?.weight
    });
    // Out of sight, the ground and corpses are as it last saw them, for as long as their kind is
    // seen to stay (places.ts).
    const shown = new Set([...view.ground, ...view.corpses].map((thing) => thing.serial));
    const remembered = [...(this.places?.remembered() ?? [])].filter(
      (fact) => !shown.has(fact.serial) && !this.things.owned.has(fact.serial) && !this.creature(fact.name)
    );
    const corpse = (name: string) => name.split('/').includes('Corpse');
    return {
      worn: view.worn.map(tag),
      pack: view.pack.map(tag),
      bank: view.bank.map(tag),
      ground: [
        ...view.ground.map(tag),
        ...remembered
          .filter((fact) => !corpse(fact.name))
          .map((fact) => ({ ...tag({ ...fact, amount: 1 }), z: 0, remembered: true }))
      ],
      corpses: [
        ...view.corpses.map((corpse) => ({ ...corpse, items: corpse.items.map(tag) })),
        ...remembered
          .filter((fact) => corpse(fact.name))
          .map((fact) => ({ serial: fact.serial, name: fact.name, x: fact.x, y: fact.y, items: [], remembered: true }))
      ]
    };
  }

  belongings(): ReadonlyMap<number, { name: string; amount: number }> {
    return this.things.owned;
  }
  // The menus a tool's use was seen to open, the menu a key stands for, and where a button leads.
  root(name: string) {
    return this.roots[name];
  }
  menu(key: string) {
    return this.menus[key];
  }
  through(key: string, button: number) {
    return this.links[`${key} ${button}`];
  }
  asksTarget(name: string) {
    return this.targetTools.has(name);
  }
  tried(name: string) {
    return this.probed.has(name);
  }
  // Whether it has tried an attempt before (and so can expect something of it).
  knows(key: string) {
    return this.beliefs.has(key);
  }
  // How many of a kind of thing it carries in reach: what a learned attempt's costs are paid from.
  owned(name: string) {
    let carried = 0;
    for (const [serial, item] of this.things.owned)
      if (item.name.split('/').includes(name) && !this.banked(serial)) carried += item.amount;
    return carried;
  }
  spellMissing(spell: number) {
    return this.missingSpells.has(spell);
  }
  refuseSpell(spell: number) {
    if (this.missingSpells.has(spell)) return;
    this.missingSpells.add(spell);
    this.write('spell-missing', { spell });
  }
  funds() {
    let carried = 0,
      banked = 0;
    for (const [serial, item] of this.things.owned)
      if (item.name === 'Gold') {
        if (this.things.inBank(serial)) banked += item.amount;
        else carried += item.amount;
      }
    return carried + (this.bankGold ?? banked);
  }
  skill(name: string) {
    return this.self.skill(name);
  }
  // Putting these of its things in the bank, in seconds of its usual progress: what it would stand to
  // lose of them by dying before it is next back, as timid as it is. How often it dies a second is its
  // own deaths over its life, starting from a guess of one in its first hour; how long until it is
  // next back is how long it has gone between deposits, starting from that hour too. Guard protection
  // replaces that prior with the next activity's modeled risk.
  deposit(serials: readonly number[], nextRisk = 0) {
    const lived = this.beliefs.lived;
    const carried = serials.reduce((sum, serial) => {
      const item = this.things.owned.get(serial);
      return sum + (item ? worth(item.name) * item.amount : 0);
    }, 0);
    const deaths = (lived.died + 1) / (lived.seconds + 3600);
    const away = (lived.seconds + 3600) / (this.deposits + 1);
    const rates = usual([lived], this.trade);
    const protectedHere = this.guarded;
    const risk = protectedHere ? Math.max(0, Math.min(1, nextRisk)) : Math.min(1, deaths * away);
    return round(((2 - this.traits.boldness) * carried * risk) / rates.gold);
  }

  // What a thing in view is worth to it, a whole stack of it (what a vendor pays).
  worthOf(serial: number) {
    const name = this.things.names.get(serial);
    return name ? worth(name) : 0;
  }
  // All it has gained of its life goal so far: goods, skill and kills, added up. What it does that
  // leaves this where it was has brought nothing.
  get progress() {
    const lived = this.beliefs.lived;
    return goods(lived) + lived.skill + lived.killed;
  }
  // What paying so much gold costs it, in seconds of its usual progress, as greedy as it is.
  cost(gold: number) {
    return ((1 + this.traits.greed) * gold) / usual([this.beliefs.lived], this.trade).gold;
  }
  // What a thing's hover said, and what one of a kind of thing weighs (undefined until hovered).
  described(serial: number) {
    return this.things.described.get(serial);
  }
  unitWeight(name: string) {
    return this.things.unitWeight(name);
  }
  graphicOf(serial: number) {
    return this.things.graphics.get(serial);
  }

  // Whether one of its things lies in its bank box.
  banked(serial: number) {
    return this.things.inBank(serial);
  }
  // Whether a skill is one of its trade's (any skill, when it has no trade).
  inTrade(skill: string) {
    return !this.trade || this.trade.has(skill);
  }
  get mount() {
    return this.things.mount;
  }
  get skillTotal() {
    return this.self.skillTotal;
  }
  // How many steps the way from one spot to another takes (walk-graph.ts), once the land is known.
  steps?: Steps;
  encounter?: Encounter;
  creature(name: string | undefined) {
    return this.fight.isCreature(name);
  }
  // What so many seconds cost it while creatures that struck it are still about, unless it spends
  // them fighting one of them: the chance they kill it meanwhile, valued as dying is.
  pressed(seconds: number, fighting?: number) {
    const foes = [...this.things.mobiles].flatMap((serial) => {
      const name = this.things.names.get(serial);
      return serial !== fighting && name && this.fight.foe(serial) ? [name] : [];
    });
    const died = this.fight.endured(foes, seconds, this.health);
    if (!died) return 0;
    const carried = [...this.things.owned].reduce(
      (sum, [serial, item]) => sum + (this.things.inBank(serial) ? 0 : worth(item.name) * item.amount),
      0
    );
    return value(
      { ...empty(), seconds: 0, died },
      this.traits,
      usual([this.beliefs.lived], this.trade),
      carried,
      this.trade,
      this.price
    );
  }
  struck(serial: number) {
    return this.fight.foe(serial);
  }
  // Whether a creature is worth fighting at all: one that attacks people, or one that struck it.
  foe(name: string, serial: number) {
    return !this.fight.harmless(name) || this.fight.foe(serial);
  }
  get temper(): Readonly<Traits> {
    return this.traits;
  }

  journeys() {
    return journeys(this.deliberation());
  }

  consider() {
    return consider(this.deliberation());
  }

  private deliberation() {
    return {
      beliefs: this.beliefs,
      things: this.things,
      fight: this.fight,
      ventures: this.ventures,
      where: this.where,
      health: this.health,
      traits: this.traits,
      trade: this.trade,
      expected: (key: string) => this.expected(key),
      market: this.price,
      steps: this.steps,
      // Where it may go, and has not learned its hands cannot walk to from here.
      allowed: (p: { x: number; y: number; z?: number }) => this.allowed(p) && this.reachable(p)
    };
  }

  private write(kind: string, data: object, at = Date.now()) {
    this.record({
      resident: this.resident,
      at,
      kind,
      data,
      via: 'told',
      ...(this.where ? { where: this.where } : {})
    });
  }
}
