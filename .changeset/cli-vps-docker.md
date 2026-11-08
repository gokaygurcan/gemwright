---
"@gemwright/cli": minor
---

VPS deployments run Docker only: `gemwright shard setup` prepares a server over SSH, including swap on small servers; deploys check the server first, build images on the deploying machine, restart only the named components, run AI residents, serve the browser client over HTTPS on a configurable domain, and finish only when players can connect. Native VPS mode is removed.
