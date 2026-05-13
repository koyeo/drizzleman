# drizzleman

Transparent proxy for `drizzle-kit` that adds safety hooks around `generate`, `migrate`, `push`, plus a standalone `check-migrations` command.

## Install

```sh
make install
```

This runs `pnpm install && pnpm build && npm link`, putting `drizzleman` on your `PATH`. Inside a project that already depends on `drizzle-kit`, replace any `drizzle-kit <cmd>` with `drizzleman <cmd>`.

## Behaviour

| Command | Behaviour |
|---|---|
| `drizzleman generate` | Prints target DB URL → checks local journal max vs DB max → only forwards to `drizzle-kit` when aligned (so new file = DB max + 1). |
| `drizzleman migrate` | Prints target URL → lists pending files → confirms (or `--yes`) → forwards → re-checks alignment. |
| `drizzleman push` | Prints target URL → forwards. |
| `drizzleman check-migrations` | Standalone alignment check; never invokes `drizzle-kit`. |
| `drizzleman info` | Probe the target DB and print its engine (`PostgreSQL` / `MySQL` / `MariaDB` / `SQLite` / `CockroachDB` / ...), full `version()` string, and parsed `major.minor.patch`. Postgres uses `server_version_num` for authoritative integer parsing; mysql distinguishes MySQL vs MariaDB via `@@version_comment`. Read-only. |
| `drizzleman align [--apply]` | Reconcile journal: rename `.sql` / `meta/<NNNN>_snapshot.json` so each tag prefix matches its `idx`. Default is dry-run (prints a plan table); `--apply` actually renames + rewrites journal (after backing it up to `_journal.json.bak.<ts>`). DB is untouched. |
| `drizzleman renumber [--apply]` | Reorder entries by the snapshot `prevId` chain and reassign `idx = 0..N-1` to that chain position, then rename `.sql` / snapshot to match. **Refuses** if the chain is not a clean linear DAG (fork / cycle / multiple-genesis / dangling parent / orphan / journal-snapshot mismatch) OR if chain order disagrees with `when` order (some `when` got hand-edited). Forks → regenerate the later branch via `drizzle-kit generate`; when/chain mismatch → correct the hand-edited `when`. DB untouched; backup auto-cleans on full success. |
| `drizzleman rebase` | Rebuild migration history with a **three-proposition verify gate** before touching `out/` or the migrations table. Modes for two required temp DBs: (a) `--admin-db-url=<url>` (or `DRIZZLEMAN_ADMIN_DB_URL`) — a high-privilege Postgres URL with `CREATEDB`; drizzleman auto-creates `drizzleman_schema_<YYYYMMDD_HHmmss>` + `drizzleman_verify_db<YYYYMMDD_HHmmss>`; (b) `--empty-schema-db-url=<url>` **and** `--verify-db-url=<url>` (or env `DRIZZLEMAN_EMPTY_SCHEMA_DB_URL` / `DRIZZLEMAN_EMPTY_VERIFY_DB_URL`) — two pre-created empty Postgres DBs. The two modes are mutually exclusive. Steps: (A) introspect target DB → preview `0000_<slug>.sql` + `meta/0000_snapshot.json` + `schema.ts`/`relations.ts`; (B) assert schema/verify DBs are empty; (C) `drizzle-kit generate → migrate` local schema → schema DB; (D) introspect schema DB; (E) structural snapshot diff; (F) chunk both 0000 SQLs; (G) write `0001_delta.sql` + `schema.sql`; (V) **verify gate** — V1: apply 0000 to verify DB, `migra verify target` must be empty (命题 ① 0000 ≡ target); V2: apply 0001 on top, `migra verify schema` must be empty (命题 ② 0000+0001 ≡ local schema); V3: introspect verify DB, `diffSnapshots(verify, tmpgen)` must be empty (drizzle-layer cross-check); any failure → preview retained, no apply, exit non-zero; (H/I/J) render preview, prompt (or `--yes`), then promote preview + reset `__drizzle_migrations`. Backups go to `.rebase-bak-<ts>/` + `<schema>.rebase-bak-<ts>` table. `--verify-only` runs the gate and exits without applying. Requires external [`migra`](https://github.com/djrobstep/migra) on PATH (`pipx install migra`). Postgres only. Both temp DBs are **never auto-dropped** — drizzleman prints exact `DROP DATABASE "..."` commands at the end. Before Step C, runs a **Step Bv** that probes all three DBs (target / schema / verify) and refuses to continue unless they share the same engine name AND same major version (use `--allow-version-mismatch` to relax the major-version check; engine mismatch is never overrideable). |
| `drizzleman <anything else>` | Passed straight through to `drizzle-kit` (stdio + exit code preserved). |

Configuration comes from your project's existing `drizzle.config.ts` / `.js` / `.json` — drizzleman never introduces its own config file.

## Uninstall

```sh
make unlink
```
