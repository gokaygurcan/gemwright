# Skill usage guide

[Documentation index](README.md)

Where and how each skill is ordinarily trained or used, as guidance for idle-time training and activity choice. Provided by the project owner.

| Skill | Where / how |
| --- | --- |
| Anatomy | Anywhere; can be used on the character itself |
| Animal Lore | Anywhere; can be used on any mount |
| Animal Taming | Mainly outside town; tame progressively tougher animals, then release them |
| Archery | Graveyards, dungeons |
| Arms Lore | Anywhere; on any weapon or armor piece |
| Blacksmithy | Mainly in town (needs anvil and/or forge) |
| Carpentry | Anywhere, better in town |
| Detect Hidden | Anywhere, no limitation |
| Discordance | Anywhere, mainly graveyards and dungeons |
| Eval Int | Anywhere; major support skill for Magery |
| Fencing | Graveyards, dungeons |
| Healing | Anywhere, mainly graveyards and dungeons |
| Hiding | Anywhere, any time |
| Imbuing | Mainly in town |
| Inscription | Mainly in town, close to bank or vendors |
| Lumberjacking | Mainly outside town |
| Mace Fighting | Graveyards, dungeons |
| Magic Resist | Passive; gains when someone else casts on the character |
| Magery | Everywhere: protective spells on self or others, attack spells on creatures |
| Meditation | Almost every time after Magery is used |
| Mining | Mainly outside town (mines) |
| Musicianship | Anywhere, together with other bard skills |
| Parrying | Passive; gains when hit while holding a shield |
| Peacemaking | Anywhere, mainly graveyards and dungeons |
| Poisoning | Support for Magery poison, or poisoning weapons |
| Provocation | Outside town, mostly on monsters |
| Snooping | Anywhere; criminal if caught |
| Stealing | Anywhere; criminal if caught |
| Stealth | Anywhere |
| Swordsmanship | Graveyards, dungeons |
| Tactics | Passive; gains with any combat skill |
| Tailoring | Mainly in town |
| Tinkering | Anywhere; mainly to replace broken mining tools, also other uses |
| Tracking | Anywhere; to find animals to tame |
| Veterinary | On any animal |
| Wrestling | Graveyards, dungeons |

## Implementation notes (pinned ServUO)

- Anatomy and Eval Int give no gain on the character itself (500324, "You know yourself quite well enough already"); residents study their own horse or a nearby fellow resident instead.
- Skill delays from each skill's `OnUse`: Arms Lore, Anatomy, Eval Int, Animal Lore 1 s; Hiding and Detect Hidden 10 s.
- Trainers live in `src/skill-training.ts` (skill-use loops), `src/craft-training.ts` (Tinkering, Carpentry) and `src/magery.ts`.
