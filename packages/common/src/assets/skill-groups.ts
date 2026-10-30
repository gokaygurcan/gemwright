import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The client's skill names (skills.mul through Skills.idx: per skill an action flag and a name)
// and its default skill groups (skillgrp.mul: a group count, then 17-byte names for every group
// but the first, Miscellaneous, then each skill's group index).
export interface SkillGroup {
  name: string;
  skills: number[];
}

export function clientSkills(directory: string): { names: string[]; groups: SkillGroup[] } {
  const index = readFileSync(join(directory, 'Skills.idx'));
  const data = readFileSync(join(directory, 'skills.mul'));
  const names: string[] = [];
  for (let at = 0; at + 12 <= index.length; at += 12) {
    const offset = index.readInt32LE(at);
    const length = index.readInt32LE(at + 4);
    if (offset < 0 || length <= 0) continue;
    names.push(
      data
        .subarray(offset + 1, offset + length)
        .toString('latin1')
        .split('\0')[0] ?? ''
    );
  }
  const groupsFile = readFileSync(join(directory, 'skillgrp.mul'));
  let count = groupsFile.readInt32LE(0);
  let start = 4;
  let width = 17;
  const unicode = count === -1;
  if (unicode) {
    count = groupsFile.readInt32LE(4);
    start = 8;
    width = 34;
  }
  const groups: SkillGroup[] = [{ name: 'Miscellaneous', skills: [] }];
  for (let i = 0; i < count - 1; i++) {
    const raw = groupsFile.subarray(start + i * width, start + (i + 1) * width);
    const name = (unicode ? raw.toString('utf16le') : raw.toString('latin1')).split('\0')[0] ?? '';
    groups.push({ name, skills: [] });
  }
  for (let at = start + (count - 1) * width, skill = 0; at + 4 <= groupsFile.length; at += 4, skill++)
    groups[groupsFile.readInt32LE(at)]?.skills.push(skill);
  return { names, groups };
}
