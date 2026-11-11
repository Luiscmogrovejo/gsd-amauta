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

<step name="local_update_procedure">
Show the real update procedure — the installer, run from the verified local repo:

```
### Update from the local repo

1. cd <your gsd-amauta clone>          # e.g. ~/Code/gsd-amauta
2. Verify integrity first:
     git fsck --no-dangling && git log --oneline -3   # confirm HEAD is your own work
3. git pull                                           # from your own remote only
4. node bin/init.cjs --upgrade
     - re-runs bin/install.js, which rewrites `~/.claude/` paths inside the
       installed copies and regenerates gsd-file-manifest.json
     - applies new SQL migrations on PostgreSQL (on SQLite nothing is applied
       and nothing is recorded as applied)
     - updates ~/.amauta/data/install_record.json and restarts the daemon
     Preview first with: node bin/init.cjs --upgrade --dry-run --json
5. Verify: node bin/cli.cjs doctor
     install_drift must be OK and version_skew must show installed == package.
     Exit 0 = healthy, 1 = degraded, 2 = failing.
6. Restart Claude Code to pick up changes.
```

**Do NOT hand-copy files into `~/.claude/`.** A raw `cp` / `rsync` sync:
  - skips install.js's path rewriting, so the installed copies point at the
    wrong config dir;
  - never regenerates `gsd-file-manifest.json`, so every later drift check and
    local-patch backup compares against a stale baseline (and `doctor` then
    reports drift for files you copied correctly);
  - used to copy `get-shit-done/VERSION`, a file that does not exist in the
    repo — the `|| true` hid that, leaving the installed VERSION stale forever.

If the operator asks to re-enable automated updates, require an explicit
decision naming a TRUSTED source (the local repo path or a private registry) —
never default back to the public npm package.
</step>

</process>

<success_criteria>
- [ ] NO npm/npx command executed (no `npm view`, no `npx get-shit-done-cc`)
- [ ] Refusal + reason displayed
- [ ] The installer-based local-repo update shown (`git pull && node bin/init.cjs --upgrade`)
- [ ] Raw copy/rsync NOT presented as an update path (it loses path rewriting and the manifest)
- [ ] Post-update verification with `gsd-amauta doctor` shown
</success_criteria>
