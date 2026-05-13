# Feedback

执行 proposal 期间冒出的、未在当前会话处理的事项。收尾后由用户决定要不要新开 proposal / plan 处理。

---

## [plans/001-probe-info-rebase-gate.md] info 命令名是否换为 detect

- **类型**:设计调整
- **位置**:`src/hooks/info.ts`、`src/cli.ts` `HOOK_COMMANDS`、`src/hooks/index.ts`
- **描述**:用户原指令是"提供 detect 命令",我用了 `info`(理由:更短、更符合 `docker info` / `kubectl cluster-info` 习惯)。如果你倾向 `detect`,替换是机械操作(改三处字符串 + README)。
- **建议**:待决策。语义上两个都对,选风格。

## [plans/001-probe-info-rebase-gate.md] postgres 探测异常时空消息兜底

- **类型**:bug / 体验优化
- **位置**:`src/hooks/info.ts` catch 分支(也影响 `src/hooks/rebase.ts` Step Bv 的失败显示)
- **描述**:实测 `postgres://nope@localhost:1/nope` 触发 pg 驱动 reject,但 `err.message` 是空字符串,导致 info 输出 "[drizzleman] ✗ failed to probe postgresql target:" 后空白。生产环境通常会有正常 ECONNREFUSED / 认证失败消息,但兜底总比裸露安全。
- **建议**:catch 处 `const msg = err instanceof Error ? (err.message || (err as NodeJS.ErrnoException).code || String(err)) : String(err);`

## [plans/001-probe-info-rebase-gate.md] CockroachDB / Yugabyte 端到端验证缺失

- **类型**:范围外发现
- **位置**:`src/db/probe.ts` postgres 分支的 fallback 字符串解析
- **描述**:对非 stock postgres 引擎(CockroachDB / YugabyteDB / Aurora 等),`current_setting('server_version_num')` 行为未确认 —— CockroachDB 可能不实现这个 setting,会落到字符串 fallback。字符串解析对 "CockroachDB CCL v23.1.0" 是否能切对版本号也只是 hope-based。
- **建议**:在能搞到 CockroachDB / Yugabyte 测试实例的环境跑一次 `drizzleman info`,确认 engine 名和版本号都正常解析;不行就在 fallback 里加更鲁棒的多形态正则(`v?(\d+)\.(\d+)\.(\d+)`)。

## [plans/001-probe-info-rebase-gate.md] sqlite 本机 native binding 缺失

- **类型**:范围外发现 / 环境问题
- **位置**:`node_modules/.pnpm/better-sqlite3*` 没编出 .node
- **描述**:`pnpm install` 后 better-sqlite3 的 prebuild 没跑通,导致本机 `drizzleman info`(sqlite dialect)爆 binding 路径错误。与本 plan 无关,但会影响后续 sqlite 项目的本地开发。
- **建议**:在 README 的 Install 段提一句"如果遇到 better-sqlite3 binding 错误,跑 `pnpm rebuild better-sqlite3`";或者在 Makefile 的 `install` target 后加 `pnpm rebuild` 一行。
