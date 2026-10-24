# Conversation

[Documentation index](README.md)

Residents talk with players and with each other. `dialogue.ts` holds the session-free logic (intents, threads, reply options); `conversation.ts` hears speech, asks Jev, and speaks. Every reply is authored and built from the resident's real state: its goal, home town and catalogued landmarks. Nothing is promised that no behavior can carry out.

## Hearing

A listener per resident polls the journal every 1.5 seconds. Labels, emotes, system lines and speech older than 30 seconds are ignored. A line is considered when it names the resident, continues a conversation with the speaker, or (players only) comes from within four tiles. A line naming someone else and not this resident is their conversation. When a line names no one and others are within eight tiles, Jev answers "is this addressed to me?" (`speech-addressee`) from the line, the recent speech around, and whether the resident is talking with the speaker.

## Understanding

Each line has one intent: greet, doing, where, help, follow, acknowledge, clarify, bye, or chatter. The authored patterns are the baseline; with Jev, a `speech-intent` decision reads the line in context. Patterns understand both everyday English and the game's register ("What brings thee here?", "And thou?", "Fare thee well").

## Threads

Speech from one partner forms a thread (`threadFor`):

- **Repeats.** The same question twice is answered again ("As I told thee, …"), never by nesting earlier repeats; a second greeting needs no answer; directions to a different place are not a repeat.
- **"What?"** repeats the resident's last line.
- **Pauses.** A partner who returns after a minute is welcomed back ("Back again?").
- **Caps.** A conversation wraps up after eight lines from a player or three from a fellow resident.
- **Endings.** A goodbye closes the thread. Stop words ("stop", "enough", "quiet", "leave me alone", "go away", "not now") close it in silence.
- **Quiet after.** For three minutes after any conversation ends, the resident answers only real requests (directions, help, follow), does not greet other residents, and gives a closed conversation's partner one "We have spoken already" at most.

## Replying

`replyOptions` offers every truthful reply for the intent and thread: return a greeting, share the current activity, ask back, repeat, stay quiet, give directions (compass direction and paces to the nearest bank, healer, smith, stables, mines or cemetery), offer advice, or decline. With Jev, a `speech-reply` decision picks among them; otherwise the local rule does. Help requests are a `help-request` decision. Following is declined until commitments become goals. Acknowledgements are only answered when the resident's last line asked something, so thanks never ping-pong.

Lines follow the game's own NPC voice (`Cliloc.enu`): plain sentences with a light Britannian layer, "thee/thou/thy", "Fare thee well", "Begging thy pardon", without heavy archaism.

Conversations raise affinity slightly and are remembered in the checkpoint.

## Moving or standing

Talking competes with moving for the same hands (`engagement.ts`): the mouse steers, the keyboard types. A resident on the move answers in a word or two, lowercase and sometimes with two letters swapped ("hi", "busy, sry"), or not at all; replies take typing time, about five characters a second standing. When a player addresses a resident it chooses to ignore them, answer in passing, or stop: more likely standing still, when sociable, when the player stands within three tiles, when the player keeps trying, and when asked to wait or to trade. Once engaged, every walk waits until the player leaves (over six tiles), says goodbye, or stays quiet for a minute (five minutes at most), so a conversation happens with both sides standing. A bare "stop" or "wait" means stop walking ("stop talking" still ends it), a player's closed conversation reopens when they speak again, and a repeated greeting gets "Yes?". Asked to trade, an engaged resident quotes its largest carried lot of a market good, halfway between the shop's prices, and answers that player's trade window with it; any other window is refused (`trade-guard.ts`). Fellow residents answer each other in passing while moving.

## Phrasing with Claude

With `"ai": { "speech": "claude" }` in `gemwright.json` (or `--speech claude`, and `ANTHROPIC_API_KEY` in the environment), `phrasing.ts` has Claude Haiku 5.5 say the chosen reply in the resident's own voice. Jev or the local rule still decides what to say; exact repeats ("I said: …") are never rephrased.

- **Guard.** A rephrasing is spoken only if it stays one short line, keeps every number and name of the authored line (a person may be called by first name), adds no number, name or promise, and has no stage directions. Otherwise, after a 2.5 s timeout, without a key, or over budget, the authored line is spoken. Rejections are logged with their reason.
- **Cost.** The voice instructions (719 tokens, with examples from the game's own NPC lines) are a cached prefix shared by every resident. Each authored line keeps up to three accepted rephrasings and reuses them without a request once it has three. At most 120 requests per resident per hour, no retries, thinking off at low effort. `phrasingUsage()` reports requests, reuses, rejections, tokens and estimated cost; a full conversation lab run costs about $0.0006.
