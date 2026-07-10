<purpose>
SAFETY-NEUTRALIZED update workflow (2026-07-10). The upstream npm package
`get-shit-done-cc` was reported compromised. This fork (gsd-amauta) MUST NEVER
be updated from npm — updates come ONLY from the local, git-verified repository
via a manual file sync. This workflow refuses any npm/npx update path and
documents the safe manual procedure instead.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="refuse_npm_update">
**Do NOT run `npm view`, `npm install`, or `npx get-shit-done-cc` in any form.**
The upstream npm package is not trusted (reported compromised). There is nothing
to check on npm: this installation is a local fork updated from its git repo.

Display:

```
## Amauta Update — npm path disabled (supply-chain safety)

This installation is the LOCAL FORK gsd-amauta, updated only from the
git-verified repository — never from npm.

⛔ Upstream npm package `get-shit-done-cc` is NOT trusted (reported
   compromised 2026-07). The npm/npx update path has been removed.
```
</step>

<step name="manual_update_procedure">
Show the safe manual update procedure (verified file sync from the local repo):

```
### Safe manual update (from the local repo)

1. cd /Users/luismogrovejo/Code/gsd-amauta
2. Verify integrity first:
     git fsck --no-dangling && git log --oneline -3   # confirm HEAD is your own work
3. Sync the verified content manually (plain copies — do not run installer scripts
   you have not just reviewed):
     - agents:    cp agents/gsd-*.md ~/.claude/agents/
       (note: installed copies legitimately differ from repo where the installer
        expanded `~/.claude/` to absolute paths inside command examples)
     - engine:    rsync -a --delete get-shit-done/bin/ ~/.claude/get-shit-done/bin/
     - workflows: rsync -a get-shit-done/workflows/ ~/.claude/get-shit-done/workflows/
     - hooks:     cp hooks/dist/*.js hooks/dist/*.cjs ~/.claude/hooks/ 2>/dev/null;
                  cp hooks/dist/lib/*.cjs ~/.claude/hooks/lib/
     - version:   cp get-shit-done/VERSION ~/.claude/get-shit-done/VERSION 2>/dev/null || true
4. Verify after sync: spot-hash a few files against the repo
     (shasum -a 256 <installed> <repo> — pairs must match).
5. Restart Claude Code to pick up changes.
```

If the operator asks to re-enable automated updates, require an explicit
decision naming a TRUSTED source (the local repo path or a private registry) —
never default back to the public npm package.
</step>

</process>

<success_criteria>
- [ ] NO npm/npx command executed (no `npm view`, no `npx get-shit-done-cc`)
- [ ] Refusal + reason displayed
- [ ] Manual, verified local-repo sync procedure shown
</success_criteria>
