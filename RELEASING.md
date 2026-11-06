# Releasing

Loop Engineering is released as git tags `vX.Y.Z` on `main`, each with a GitHub release whose notes are that version's section of [CHANGELOG.md](CHANGELOG.md). Run a tag in production rather than following `main`: `main` moves whenever a PR merges, and a release is a point someone checked.

## Versions

[Semantic Versioning](https://semver.org/spec/v2.0.0.html), starting at 0.x. The version lives in the root `package.json` (the workspaces keep their own `0.0.0` and are not published).

While the major version is 0:

- **Minor** (`0.2.0`): anything an operator must act on or could be surprised by. A database migration, since migrations are one-way and older code refuses a newer database. A removed or renamed `.env` variable, setting, API route or feature. A changed default that changes what the loop does on its own, such as merging, reverting or resuming.
- **Patch** (`0.1.1`): fixes, docs, and additions that need no action: new optional variables with defaults that keep the old behaviour, new routes, new tests.

1.0.0 will come when the data model and the `.env` names are stable enough to promise that minors never need action.

## Cutting a release

From an up-to-date `main` with every PR for the release merged:

1. **Check it.** CI's checks plus `npx tsc -b`, on the commit you will tag:

   ```sh
   git switch main && git pull --ff-only
   npm ci
   npx tsc -b && npm run typecheck && npm run lint && npm test && npm run build
   ```

2. **Write the changelog.** In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]` above it, and update the link references at the bottom:

   ```md
   [Unreleased]: https://github.com/lanyado/loop-engineering/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/lanyado/loop-engineering/compare/vPREVIOUS...vX.Y.Z
   ```

   (For the first release, `[0.1.0]: https://github.com/lanyado/loop-engineering/releases/tag/v0.1.0`.) Replace any note written while the section was unreleased (such as "Planned as 0.1.0…") with a one-line summary of the release, since the section becomes the release notes as written. Every migration and every action an operator must take goes under **Upgrade notes**, with the commands.

3. **Bump the version** in the root `package.json` only, without creating a tag yet:

   ```sh
   npm version X.Y.Z --no-git-tag-version --workspaces=false
   ```

   This also updates the root entry in `package-lock.json`.

4. **Merge it.** Open a PR with the three files (`CHANGELOG.md`, `package.json`, `package-lock.json`) titled `Release X.Y.Z`, let CI pass, and squash-merge it.

5. **Tag the merge commit** and push the tag:

   ```sh
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. **Create the GitHub release**, with the version's changelog section as its notes:

   ```sh
   awk -v v="X.Y.Z" '/^## \[/ { if (p) exit; if (index($0, "## [" v "]") == 1) { p = 1; next } } p' CHANGELOG.md > notes.md
   gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file notes.md
   ```

Never move or delete a tag once pushed: production may be pinned to it. Fix forward with a patch release.

**Optional: automate step 6.** [`docs/examples/release.yml`](docs/examples/release.yml) is a GitHub Actions workflow that runs on a pushed `vX.Y.Z` tag. It checks that the tag matches `package.json`, runs CI's checks, and creates the release from the changelog section, unless the release exists already. It needs no secrets beyond the built-in `GITHUB_TOKEN`. To turn it on, move it to `.github/workflows/release.yml` and push that commit; pushing a workflow file needs a GitHub token with the `workflow` scope (`gh auth refresh -s workflow`).

## Running a release in production

Check out the tag instead of following `main`. There are no tags yet: v0.1.0 is to be cut right after the PRs it covers (#39 to #44) are merged. A fresh install:

```sh
git clone https://github.com/lanyado/loop-engineering.git
cd loop-engineering
git checkout v0.1.0
npm ci
npm run setup
```

The checkout is a detached `HEAD`, which is what you want: `git pull` refuses to run there, so nothing moves until you choose the next tag. Don't run an updater that pulls `main` on a production machine.

### Upgrading and rolling back

Read the new version's **Upgrade notes** first. Then, with [systemd user units](docs/unattended.md#services) (use your own stop and start commands otherwise):

```sh
cd ~/loop-engineering
systemctl --user stop loop-server loop-dashboard

# 1. Back up the database, whatever the release notes say. The backup command is safe on a live
#    database in WAL mode; a plain cp of loop.db is not.
sqlite3 data/loop.db "PRAGMA user_version"              # the schema version now, for the record
sqlite3 data/loop.db ".backup data/loop.db.pre-vX.Y.Z"

# 2. The new code.
git fetch --tags
git checkout vX.Y.Z
npm ci
npm run build
# A local/ add-in builds against these packages: rebuild it now (docs/reference.md#local-add-ins).

# 3. Start. Migrations run on this first start.
systemctl --user start loop-server loop-dashboard
journalctl --user -u loop-server -n 50 --no-pager
```

Running builders are not stopped by a server restart (the tmux server is left alone, see [the guide](docs/unattended.md#services)). They keep the instructions they started with until their next resume. Running PR jobs are interrupted and start again after the restart.

**To roll back**, stop the services and the timers that open the database, `git checkout v<previous>`, `npm ci && npm run build`, and, if the newer version ran a migration, restore the backup before starting. Remove the write-ahead files before copying: a stale WAL would be replayed onto the restored file and migrate it again.

```sh
systemctl --user stop loop-server loop-dashboard loop-backup.timer loop-retro.timer
git checkout vPREVIOUS && npm ci && npm run build
rm -f data/loop.db-wal data/loop.db-shm
cp data/loop.db.pre-vX.Y.Z data/loop.db
systemctl --user start loop-server loop-dashboard loop-backup.timer loop-retro.timer
```

Older code refuses a newer database (`Database schema version N is newer than this code (M)`), so the restore is not optional after a migration. Anything recorded between the upgrade and the rollback is lost with it: sessions started since are no longer known, so their PRs leave the loop (they stay open on GitHub) and their tmux windows keep running until you close them (`tmux attach -t loop`). Roll back soon, or not at all.
