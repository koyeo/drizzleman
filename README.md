# drizzlex

Transparent proxy for `drizzle-kit` that adds safety hooks around `generate`, `migrate`, `push`, plus a standalone `check-migrations` command.

## Install

```sh
make install
```

This runs `pnpm install && pnpm build && npm link`, putting `drizzlex` on your `PATH`. Inside a project that already depends on `drizzle-kit`, replace any `drizzle-kit <cmd>` with `drizzlex <cmd>`.

## Behaviour

| Command | Behaviour |
|---|---|
| `drizzlex generate` | Prints target DB URL → checks local journal max vs DB max → only forwards to `drizzle-kit` when aligned (so new file = DB max + 1). |
| `drizzlex migrate` | Prints target URL → lists pending files → confirms (or `--yes`) → forwards → re-checks alignment. |
| `drizzlex push` | Prints target URL → forwards. |
| `drizzlex check-migrations` | Standalone alignment check; never invokes `drizzle-kit`. |
| `drizzlex <anything else>` | Passed straight through to `drizzle-kit` (stdio + exit code preserved). |

Configuration comes from your project's existing `drizzle.config.ts` / `.js` / `.json` — drizzlex never introduces its own config file.

## Uninstall

```sh
make unlink
```
