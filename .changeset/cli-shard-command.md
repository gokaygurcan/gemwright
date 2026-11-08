---
"@gemwright/cli": minor
---

The CLI is now `gemwright init` and `gemwright shard <command>` (setup, deploy, start, stop, status, logs, pull, restore, update), each with its own flags and help. `--target local|railway|vps` replaces `--local`, and the last deployed target becomes the default. Old commands fail with the new one to use.
