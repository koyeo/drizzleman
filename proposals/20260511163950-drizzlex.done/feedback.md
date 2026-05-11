# Feedback

执行 proposal 期间冒出的、未在当前会话处理的事项。收尾后由用户决定要不要新开 proposal / plan 处理。

---

## [plans/002-generate-migrate-hooks.done.md] pnpm + better-sqlite3 原生 binding 体验

- **类型**: 范围外发现 / UX
- **位置**: `package.json` optionalDependencies + 用户运行时
- **描述**: pnpm 默认 ignore 第三方包的 build script, 导致 `better-sqlite3` 的 `.node` 二进制不会编译, 用户第一次跑 `drizzlex check-migrations` (sqlite) 时会看到 "Could not locate the bindings file" 一大坨错误。npm/yarn 用户不会遇到 (它们默认会跑 build script)
- **建议**: 在 README "Install" 节加一句 sqlite 用户提示 (`pnpm approve-builds` 或装时加 `--allow-build=better-sqlite3`); 或者在 safeImport 抛出错误时识别 "bindings file" 文案给出更友好的 hint。优先级低, 短期可不动

## [plans/002-generate-migrate-hooks.done.md] db-extra 场景的提示文案

- **类型**: 优化
- **位置**: `src/hooks/migrate.ts`
- **描述**: 当 DB 里有本地不存在的迁移 hash (dbExtra > 0) 时, 我们只打 yellow 警告但仍允许 migrate 继续。实际上这种情况 drizzle-kit 大概率会成功 (它按 journal 顺序检查), 但也意味着 "本地 journal 落后于 DB" — 真要 generate 一定会被 generate hook 阻塞。当前只在 migrate 时警告, 没有给"建议先 pull"的明确动作指引
- **建议**: 文案改为 "Pull/sync drizzle/ from the branch that ran ahead before generating new migrations"

## [plans/002-generate-migrate-hooks.done.md] generate 阻塞场景的可绕过开关

- **类型**: 设计调整
- **位置**: `src/hooks/generate.ts`
- **描述**: 当前 L != M 一律 hard-block。极端场景 (修复迁移、手动协调) 用户可能希望强行让 drizzle-kit 跑一次 generate。当前只能临时用 `drizzle-kit generate` 绕过 drizzlex
- **建议**: 加一个 `--force` flag (drizzlex 消费、不透传), 跳过对齐检查直接透传。仅在用户明确需要时再加, 默认行为不变

## [plans/002-generate-migrate-hooks.done.md] drizzle-kit migrate 不接收交互式确认

- **类型**: 设计调整
- **位置**: README / 用户预期
- **描述**: drizzlex 的 migrate 确认是在调 drizzle-kit **之前** 问的。drizzle-kit 自己 migrate 时不再问 (无交互), 顺着 stdio inherit 跑下去。这意味着 drizzlex 的 "y" 实际是"我授权 drizzlex 把后续操作交给 drizzle-kit"。文档需要解释清楚, 避免用户以为 drizzle-kit 内部还会再问一次
- **建议**: README 加一段 "Migration confirmation flow" 说明
