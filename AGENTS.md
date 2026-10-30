# agents

- Stay within the scope you were explicitly authorized, carry all the instructions and corrections forward, and ask before adding deliverables or taking actions beyond what is necessary to complete the task/request.

- Prevents files over 5,000 tokens. Tokens = bytes/4. Ignore files which are not authored by agents, like lockfiles.

- Solve the given task or problem in the most efficient and effective way. Do not bloat, or add unnecessary code or documentation. Make sure every single line added is there for a reason. Do not randomly create additional configuration files if there's already a convention within the project.

- Before any deployment and/or commit, make sure `lint` and `typecheck` scripts, and before any push make sure `test` script is clear.
