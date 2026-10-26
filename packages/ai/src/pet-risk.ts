import { monsters } from './dungeons';
import type { Entity } from './protocol/world';

const mean = (values: number[] | null) => (values?.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

export function petFightReadiness(pet: Entity, opponent: Entity, bandages: number, veterinary: number) {
  if (pet.hits === undefined || !pet.maxHits || pet.hits / pet.maxHits < 0.8)
    return { ok: false, reason: 'Companion health is unknown or needs recovery' };
  const kinds = monsters.filter((kind) => kind.bodies.includes(pet.graphic) && kind.hits && kind.damage);
  const known =
    kinds.find((kind) => kind.name?.toLowerCase() === pet.name?.toLowerCase()) ??
    kinds.sort((a, b) => mean(a.hits) - mean(b.hits))[0];
  const enemy = monsters.find(
    (kind) =>
      kind.bodies.includes(opponent.graphic) &&
      kind.name?.toLowerCase() === opponent.name?.toLowerCase() &&
      kind.aggressive
  );
  if (!known || !enemy?.hits || !enemy.damage)
    return { ok: false, reason: 'No reliable creature profile for this match' };
  if (enemy.magery > 0 && (known.resist < 40 || veterinary < 50))
    return { ok: false, reason: 'Caster requires a resistant companion and reliable veterinary care' };
  const chance = (a: number, b: number) => Math.min(1, Math.max(0.02, (a + 20) / (2 * (b + 20))));
  const petSkill = known.wrestling ?? 30;
  const foeSkill = enemy.wrestling || enemy.magery || 50;
  const swings = mean(enemy.hits) / Math.max(1, mean(known.damage)) / chance(petSkill, foeSkill);
  const spells = enemy.magery > 0 ? enemy.magery * 0.3 * Math.max(1, swings / 4) : 0;
  const loss = swings * chance(foeSkill, petSkill) * mean(enemy.damage) + spells;
  const health = (mean(known.hits) * pet.hits) / pet.maxHits;
  const affordable = bandages >= 5 && veterinary >= 30 ? 0.5 : 0.3;
  return {
    ok: health > 0 && loss / health <= affordable,
    reason: `Estimated companion health cost ${Math.round((loss / Math.max(1, health)) * 100)}%`
  };
}
