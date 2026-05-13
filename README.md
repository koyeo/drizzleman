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
| `drizzleman check-chain` | Audit the snapshot `prevId` chain (genesis → tip), the journal ↔ snapshot mapping, and drizzle-kit's next-generate baseline (the alphabetically-last snapshot). Reports: fork / cycle / orphan / dangling-parent issues; duplicate tag prefixes; entries-without-snapshot / snapshots-without-entry; "drift risk" — journal entries whose `idx` is beyond the baseline snapshot (next `generate` will likely re-emit them). Filesystem-only — never touches the DB. Exit 0 = healthy. |
| `drizzleman info` | Probe the target DB and print its engine (`PostgreSQL` / `MySQL` / `MariaDB` / `SQLite` / `CockroachDB` / ...), full `version()` string, and parsed `major.minor.patch`. Postgres uses `server_version_num` for authoritative integer parsing; mysql distinguishes MySQL vs MariaDB via `@@version_comment`. Read-only. |
| `drizzleman align [--apply]` | Reconcile journal: rename `.sql` / `meta/<NNNN>_snapshot.json` so each tag prefix matches its `idx`. Default is dry-run (prints a plan table); `--apply` actually renames + rewrites journal (after backing it up to `_journal.json.bak.<ts>`). DB is untouched. |
| `drizzleman renumber [--apply]` | Reorder entries by the snapshot `prevId` chain and reassign `idx = 0..N-1` to that chain position, then rename `.sql` / snapshot to match. **Refuses** if the chain is not a clean linear DAG (fork / cycle / multiple-genesis / dangling parent / orphan / journal-snapshot mismatch) OR if chain order disagrees with `when` order (some `when` got hand-edited). Forks → regenerate the later branch via `drizzle-kit generate`; when/chain mismatch → correct the hand-edited `when`. DB untouched; backup auto-cleans on full success. |
| `drizzleman rebase` | Rebuild migration history with a **three-proposition verify gate** before touching `out/` or the migrations table. Modes for two required temp DBs: (a) `--admin-db-url=<url>` (or `DRIZZLEMAN_ADMIN_DB_URL`) — a high-privilege Postgres URL with `CREATEDB`; drizzleman auto-creates `drizzleman_<YYYYMMDDHHmmss>_schema_db` + `drizzleman_<YYYYMMDDHHmmss>_verify_db`; (b) `--empty-schema-db-url=<url>` **and** `--verify-db-url=<url>` (or env `DRIZZLEMAN_EMPTY_SCHEMA_DB_URL` / `DRIZZLEMAN_EMPTY_VERIFY_DB_URL`) — two pre-created empty Postgres DBs. The two modes are mutually exclusive. Pipeline: (P0) assert temp DBs empty; (P1) probe engines & major versions of target/schema/verify, refuse if mismatched (`--allow-version-mismatch` relaxes the major-version check; engine mismatch is never overridable); (A) `drizzle-kit generate` from **local schema** → `0000_<slug>.sql` (0000 represents the local schema, not the target); (B) `drizzle-kit migrate` 0000 → schema DB; (C) `migra <empty_verify> <target> --unsafe` → `target.dump.sql` (verify DB is still empty, so migra outputs the "make empty look like target" SQL — equivalent to a schema-only dump but using the same schemainspect engine as the diff step); (D) `migra <target> <schema_db> --unsafe` → `0000_<YYYYMMDDHHmmss>_rebase_diff_only.sql` (target → schema delta, record-only; drizzleman post-processes it to defer DROP TYPE __old_version blocks past DROP COLUMN, and to drop/re-add enum-dependent CHECK / INDEX / DEFAULT bindings around migra's enum-rename dance); (V) **verify gate** — V1: apply `target.dump.sql` to verify DB; V2: apply the diff-only file on top; V3: `migra verify schema_db` must be empty (verify DB now == schema DB structurally); any failure → preview retained, no apply, exit non-zero; (J) backup + promote 0000 + the diff-only file (NOT in `_journal.json`, never executed by drizzleman), reset `__drizzle_migrations` with only 0000's hash. `--verify-only` runs everything up through the verify gate and exits without applying; `--check-only` is stricter — it exits right after P1 (DB empty + engine/version checks), before any SQL is generated. **The diff-only file is NEVER auto-applied to target by drizzleman** — it is record-only (not in `_journal.json`); review it then `psql target -f 0000_<YYYYMMDDHHmmss>_rebase_diff_only.sql` manually (CLAUDE.md G2/G6). Requires external [`migra`](https://github.com/djrobstep/migra) on PATH (`pipx install migra` — also inject `setuptools<81` and `psycopg2-binary` into its venv). Postgres only. Both temp DBs are **never auto-dropped** — drizzleman prints exact `DROP DATABASE "..."` commands at the end. |
| `drizzleman <anything else>` | Passed straight through to `drizzle-kit` (stdio + exit code preserved). |

Configuration comes from your project's existing `drizzle.config.ts` / `.js` / `.json` — drizzleman never introduces its own config file.

## Uninstall

```sh
make unlink
```
