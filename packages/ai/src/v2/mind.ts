import type { Spawner } from '../spawns';
import { reportedBankGold } from '../v1/bank-gold';
import { add, Beliefs, type Context, difference, empty, type Outcome, round } from './beliefs';
import { goods, honestly, usual, value, worth } from './choose';
import { consider, journeys } from './deliberate';
import type { Encounter } from './encounter';
import { Fight } from './fight';
import type { HistoryEvent } from './history';
import { foreseeHarvest, foreseeTrade } from './knowledge';
import type { Locomotion } from './motion';
import { Things } from './things';
import type { Traits } from './traits';
import { type Steps, Ventures } from './ventures';

// Verbs that move, look or toggle rather than try something.
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
  private readonly fight = new Fight();
  // Awake it chooses; re-living its past it only learns (those choices are long made).
  awake = true;
  // Acting itself (live.ts), it chooses before it acts rather than beside another's acts.
  acting = false;
  private readonly ventures: Ventures;
  private readonly things = new Things();
  private health: number | null = null;
  private maxHealth: number | null = null;
  private where: HistoryEvent['where'];
  private attempt?: {
    key: string;
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
    trade: readonly string[] = []
  ) {
    this.trade = trade.length ? new Set(trade) : undefined;
    this.ventures = new Ventures(spawners, (visit) => this.write('visited', visit));
    this.traits = { ...born };
  }
  private readonly traits: Traits;
  private readonly trade?: ReadonlySet<string>;
  // How many times it has put things in its bank box.
  private deposits = 0;
  bankGold?: number;
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
      things: this.things.snapshot(),
      ventures: this.ventures.snapshot(),
      health: this.health,
      maxHealth: this.maxHealth,
      where: this.where,
      attempt: this.attempt,
      harmed: this.harmed,
      traits: this.traits,
      deposits: this.deposits,
      bankGold: this.bankGold,
      missingSpells: this.missingSpells,
      surprised: this.surprised,
      revision: this.revision,
      refusedDrops: this.refusedDrops
    };
  }

  restore(snapshot: ReturnType<Mind['snapshot']>) {
    const { beliefs, fight, things, ventures, ...state } = snapshot;
    this.beliefs.restore(beliefs);
    this.fight.restore(fight);
    this.things.restore(things);
    this.ventures.restore(ventures);
    Object.assign(this, state);
  }

  revision = 0;
  private readonly refusedDrops = new Map<number, { amount: number | undefined; place: string }>();

  canDrop(serial: number) {
    const refused = this.refusedDrops.get(serial);
    return (
      !refused ||
      refused.amount !== this.things.owned.get(serial)?.amount ||
      refused.place !== JSON.stringify(this.where)
    );
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
    if (
      (event.kind === 'self' &&
        ((health?.current !== undefined && health.current !== this.health) ||
          Object.keys(data).some((key) => ['weight', 'attributes', 'poison', 'map', 'gold', 'mana'].includes(key)))) ||
      (event.kind === 'swing' && data.target === this.things.self) ||
      [
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
        'drop-refused'
      ].includes(event.kind) ||
      (event.kind === 'changed' && Object.keys(data).some((key) => !['serial', 'x', 'y', 'z'].includes(key)))
    )
      this.revision++;
    this.where = event.where ?? this.where;
    this.fight.observe(event, (serial) => this.things.names.get(serial));
    const outcome = this.attempt?.outcome;
    switch (event.kind) {
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
        // A session that ended without sleep (a crash) left its last attempt unfinished: unknowable.
        this.attempt = undefined;
        this.harmed = undefined;
        this.things.wake(data.serial as number);
        const health = (data.self as { health?: { current?: number; max?: number } | null }).health;
        this.health = health?.current ?? null;
        this.maxHealth = health?.max ?? null;
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
      case 'self': {
        const health = data.health as { current?: number; max?: number } | null | undefined;
        if (health?.current !== undefined) this.health = health.current;
        if (health?.max !== undefined) this.maxHealth = health.max;
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
        this.things.observe(event, outcome, this.attempt);
        if (this.things.mobiles.has(data.serial as number) && typeof data.x === 'number' && typeof data.y === 'number')
          this.ventures.saw(this.things.names.get(data.serial as number) ?? '', data.x, data.y);
        break;
      case 'heard': {
        const balance = reportedBankGold(Number(data.cliloc), String(data.arguments ?? ''));
        if (balance !== undefined) {
          this.bankGold = balance;
          this.revision++;
        }
        if (outcome && (data.name === 'System' || data.serial === 0xffffffff))
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
      this.attempt.context = this.context(this.attempt.object, this.attempt.key);
      const tool = /^double-click my (.+)$/.exec(this.attempt.key.split(' > ')[0] ?? '')?.[1];
      if (verb === 'target' && tool && !data.serial)
        this.attempt.foresight = foreseeHarvest(
          tool,
          data.graphic ? { tile: data.graphic as number } : { land: data.land as number | undefined },
          (skill) => this.fight.skill(skill)
        );
      this.predict();
      return;
    }
    this.finish(at);
    const object = [data.serial, data.vendor].find((serial) => typeof serial === 'number') as number | undefined;
    let on =
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
    const carried = [...this.things.owned.values()].reduce((sum, item) => sum + worth(item.name) * item.amount, 0);
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
      ...(trained ? { skill: this.fight.skill(trained) } : {})
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
    const carried = [...this.things.owned.values()].reduce((sum, item) => sum + worth(item.name) * item.amount, 0);
    this.beliefs.learn(attempt.key, attempt.context, observed, (o) =>
      value(o, this.traits, rates, carried, this.trade)
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
    const carried = [...this.things.owned.values()].reduce((sum, item) => sum + worth(item.name) * item.amount, 0);
    const rates = usual([this.beliefs.lived], this.trade);
    const worthOf = (o: Outcome) => value(honestly(key, o, this.traits), this.traits, rates, carried, this.trade);
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
    this.finish(Date.now());
    this.beliefs.executed(id, succeeded);
    this.write('executed', { id, succeeded });
  }

  // What it calls a thing in view, its own things, its skills and traits: what its hands work with.
  call(serial: number) {
    return this.thing(serial);
  }
  belongings(): ReadonlyMap<number, { name: string; amount: number }> {
    return this.things.owned;
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
    return this.fight.skill(name);
  }
  // Putting these of its things in the bank, in seconds of its usual progress: what it would stand to
  // lose of them by dying before it is next back, as timid as it is. How often it dies a second is its
  // own deaths over its life, starting from a guess of one in its first hour; how long until it is
  // next back is how long it has gone between deposits, starting from that hour too.
  deposit(serials: readonly number[]) {
    const lived = this.beliefs.lived;
    const carried = serials.reduce((sum, serial) => {
      const item = this.things.owned.get(serial);
      return sum + (item ? worth(item.name) * item.amount : 0);
    }, 0);
    const deaths = (lived.died + 1) / (lived.seconds + 3600);
    const away = (lived.seconds + 3600) / (this.deposits + 1);
    const rates = usual([lived], this.trade);
    return round(((2 - this.traits.boldness) * carried * Math.min(1, deaths * away)) / rates.gold);
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
    return this.fight.skillTotal;
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
    const carried = [...this.things.owned.values()].reduce((sum, item) => sum + worth(item.name) * item.amount, 0);
    return value(
      { ...empty(), seconds: 0, died },
      this.traits,
      usual([this.beliefs.lived], this.trade),
      carried,
      this.trade
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
      steps: this.steps
    };
  }

  private write(kind: string, data: object) {
    this.record({ resident: this.resident, at: Date.now(), kind, data, ...(this.where ? { where: this.where } : {}) });
  }
}
