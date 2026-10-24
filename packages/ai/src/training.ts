import { gold } from '@gemwright/common/items';
import { skillId } from '@gemwright/common/skills';

import { fundsStale, offersBank, spendableGold, withdrawAccountGold } from './bank-gold';
import type { FighterContext } from './fighter-context';
import { type ServiceType, serviceLocations } from './locations';
import { approachMobile } from './mobile-approach';
import { distance } from './navigation';
import type { Entity } from './protocol/world';

// NPC teaching on the pinned ServUO shard (BaseCreature.CheckTeachSkills / TeachEntry):
// - the context entry is TeachEntry 6000 + skill id (cliloc 3006000 + id on the wire), enabled while
//   the NPC can teach more;
// - selecting it quotes 1019077 with the price as an affix: one gold per 0.1 skill point;
// - an NPC teaches up to a third of its own skill and never above 42.0;
// - gold dropped on an NPC that is not expecting payment is kept as a gift, so payment is
//   only made right after a fresh quote from that NPC, for the quoted amount.
const QUOTE = 1019077;
const TAUGHT = [501539, 501540];
const CANNOT = [501508, 501509, 501510];
const TEACH_CAP = 42;
const RESERVE = 750;
const VISIT_BUDGET = 400;
const RETRY = 24 * 60 * 60_000;

// Which ordinary town NPCs teach which skills, from the vendors' SetSkill ranges on the pinned shard
// (BaseHealer knows Anatomy and Healing 75-97.5). Higher-skilled teachers come first.
const teacherList: [string, ServiceType[]][] = [
  ['Healing', ['healer']],
  ['Anatomy', ['healer']],
  ['Tinkering', ['tinker']],
  ['Arms Lore', ['weaponsmith', 'blacksmith']],
  ['Swordsmanship', ['blacksmith', 'weaponsmith']],
  ['Fencing', ['blacksmith', 'weaponsmith']],
  ['Mace Fighting', ['blacksmith', 'weaponsmith']],
  ['Tactics', ['blacksmith', 'weaponsmith']],
  ['Parrying', ['blacksmith']],
  ['Archery', ['bowyer']],
  ['Magery', ['mage']],
  ['Eval Int', ['mage']],
  ['Meditation', ['mage']],
  ['Magic Resist', ['mage']],
  ['Wrestling', ['mage']],
  ['Inscription', ['mage']],
  ['Blacksmithy', ['blacksmith']],
  ['Lumberjacking', ['carpenter']],
  ['Carpentry', ['carpenter']],
  ['Tailoring', ['tailor']]
];
const teachers = new Map(teacherList.map(([name, services]) => [skillId(name), services]));
// Healing success also depends on Anatomy, so a healing goal trains both.
const supporting: Record<string, string[]> = { Healing: ['Anatomy'] };

export type TrainingContext = Pick<
  FighterContext,
  | 'session'
  | 'serial'
  | 'terrain'
  | 'position'
  | 'navigate'
  | 'check'
  | 'phase'
  | 'log'
  | 'backpack'
  | 'checkpoint'
  | 'template'
  | 'nearby'
  | 'persist'
>;

const carried = (ctx: TrainingContext) =>
  [...ctx.session.world.entities.values()].filter((item) => item.parent === ctx.backpack() && item.graphic === gold);

// Pays one NPC to teach one skill. Returns the gold spent, or 0 when nothing was taught.
export async function trainFromNpc(ctx: TrainingContext, npc: Entity, skill: string, budget: number): Promise<number> {
  const { session } = ctx;
  const id = skillId(skill);
  const entry = (await session.context(npc.serial)).find((e) => e.cliloc === 3006000 + id && !(e.flags & 1));
  if (!entry) return 0;
  await approachMobile(ctx, npc.serial);
  const before = new Set(session.world.journal);
  const reply = (clilocs: number[]) =>
    session.world.journal.find((e) => !before.has(e) && e.serial === npc.serial && clilocs.includes(e.cliloc ?? 0));
  session.selectContext(npc.serial, entry.index);
  await session.waitFor(() => !!reply([QUOTE, ...CANNOT]), 'trainer quote', 4000);
  // The trainer answered: this counts as today's attempt even if nothing is bought.
  ctx.checkpoint.training = { ...ctx.checkpoint.training, [skill]: Date.now() };
  ctx.persist();
  const price = Number.parseInt(reply([QUOTE])?.text?.trim() ?? '', 10);
  if (!Number.isSafeInteger(price) || price <= 0 || price > budget) {
    ctx.log(
      `${skill} training not taken: ${reply([QUOTE]) ? `quoted ${price} gold` : 'the trainer cannot teach more'}`
    );
    return 0;
  }
  const pile = carried(ctx).find((item) => (item.amount ?? 1) >= price);
  if (!pile) {
    ctx.log(`${skill} training quoted ${price} gold, but no carried stack covers it`);
    return 0;
  }
  const paid = new Set(session.world.journal);
  const skillBefore = session.world.skills.get(id)?.base ?? 0;
  ctx.phase('training', `Paying ${price} gold for ${skill} lessons`);
  await session.giveToMobile(pile.serial, npc.serial, price);
  await session.waitFor(
    () => session.world.journal.some((e) => !paid.has(e) && TAUGHT.includes(e.cliloc ?? 0)),
    'trainer lesson confirmation',
    5000
  );
  await session.refreshSkills();
  ctx.log(`${skill} trained from ${skillBefore} to ${session.world.skills.get(id)?.base ?? '?'}`);
  return price;
}

// In town: buy lessons for goal skills still below what NPCs can teach, paid from the character's
// own banked gold above a working reserve. Each skill is attempted at most once a day.
export async function trainingVisit(ctx: TrainingContext, city: string) {
  const { session, checkpoint } = ctx;
  const base = (skill: string) => session.world.skills.get(skillId(skill))?.base ?? 0;
  // Template goals plus every archetype skill: residents buy the teachable start of all of them.
  const archetype = ctx.template.archetype;
  const goals = [
    ...Object.keys(ctx.template.behavior.trainingGoals),
    ...(archetype?.primarySkills ?? []),
    ...(archetype?.supportingSkills ?? [])
  ].flatMap((skill) => [skill, ...(supporting[skill] ?? [])]);
  checkpoint.training ??= {};
  const attempted = checkpoint.training;
  const wanted = [...new Set(goals)].filter(
    (skill) =>
      teachers.has(skillId(skill)) && base(skill) < TEACH_CAP - 5 && (attempted[skill] ?? 0) + RETRY < Date.now()
  );
  if (!wanted.length || fundsStale(checkpoint)) return;
  let budget = Math.min(VISIT_BUDGET, spendableGold(session, ctx.backpack(), checkpoint) - RESERVE);
  if (budget < 50) return;
  // Payment is a physical gold drop, the one case that needs carried coins.
  const needed = budget - carried(ctx).reduce((sum, item) => sum + (item.amount ?? 1), 0);
  if (needed > 0) {
    for (const bank of serviceLocations(city, 'banker')) {
      await ctx.navigate(bank, 4);
      const banker = ctx.nearby().find((m) => m.position && distance(ctx.position(), m.position) <= 11);
      if (banker && (await offersBank(session, banker.serial))) {
        await withdrawAccountGold(ctx, banker.serial, needed);
        break;
      }
    }
  }
  for (const skill of wanted) {
    const stops = (teachers.get(skillId(skill)) ?? []).flatMap((service) =>
      serviceLocations(city, service).map((stop) => ({ ...stop, service }))
    );
    for (const { service, ...stop } of stops) {
      if (budget < 50) break;
      ctx.check();
      ctx.phase('training-travel', `Looking for a ${service} to teach ${skill} near ${stop.name}`);
      await ctx.navigate(stop, 4);
      let spent = 0;
      for (const npc of ctx
        .nearby()
        .filter((m) => m.kind === 'mobile' && m.serial !== ctx.serial && m.notoriety === 7)) {
        try {
          spent = await trainFromNpc(ctx, npc, skill, budget);
        } catch (error) {
          if (session.phase !== 'ready') throw error;
          ctx.log(`Trainer ${npc.serial} unavailable: ${error instanceof Error ? error.message : error}`);
        }
        if (spent) break;
      }
      budget -= spent;
      if (spent) break;
    }
  }
}
