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
| `drizzleman align [--apply]` | Reconcile journal: rename `.sql` / `meta/<NNNN>_snapshot.json` so each tag prefix matches its `idx`. Default is dry-run (prints a plan table); `--apply` actually renames + rewrites journal (after backing it up to `_journal.json.bak.<ts>`). DB is untouched. |
| `drizzleman <anything else>` | Passed straight through to `drizzle-kit` (stdio + exit code preserved). |

Configuration comes from your project's existing `drizzle.config.ts` / `.js` / `.json` — drizzleman never introduces its own config file.

## Uninstall

```sh
make unlink
```
