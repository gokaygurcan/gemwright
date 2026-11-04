import { ruleSkills } from './rules';

// Skills by id (ServUO SkillName), from the rules (rules.ts: Server/Skills.cs). A skill is known by
// its enum name (`Swords`) or the name players read (`Swordsmanship`, SkillInfo).
export const skillNames = ruleSkills.map((skill) => skill.name);

const key = (name: string) => name.replace(/[^a-z]/gi, '').toLowerCase();
const ids = new Map(skillNames.map((name, index) => [key(name), index]));
ruleSkills.forEach((skill, index) => {
  ids.set(key(skill.label), index);
});

export function skillId(name: string): number {
  const id = ids.get(key(name));
  if (id === undefined) throw new Error(`Unsupported skill: ${name}`);
  return id;
}

// A skill's name as players read it (SkillInfo): `Swords` is `Swordsmanship`.
export function skillLabel(id: number): string {
  return ruleSkills[id]?.label ?? `Skill ${id}`;
}
