# Feedback

执行 proposal 期间冒出的、未在当前会话处理的事项。收尾后由用户决定要不要新开 proposal / plan 处理。

---

## [plans/001-rebase-verify.md] 默认 slug 仍是 `baseline`

- **类型**:设计调整
- **位置**:`src/hooks/rebase.ts:80`(`let name = 'baseline'`)
- **描述**:`--name` 默认值仍为 `'baseline'`,所以 0000 SQL 默认叫 `0000_baseline.sql`,不是 `0000_rebase.sql`。我保留它是因为"baseline" 本就描述 artifact(链起点),不是命令名残留。
- **建议**:待决策。要对称改成 `'rebase'` 也行,但 SQL 文件名表达"基线"语义本来就贴切。

## [plans/001-rebase-verify.md] verify 中间产物不自动清理

- **类型**:优化
- **位置**:`src/hooks/rebase.ts` Step J 末尾
- **描述**:`.rebase-verifymig-<ts>/`(verify staging dir,内含 0000 SQL 副本、meta、临时 `drizzle.config.json`)和 `.rebase-verifyintro-<ts>/`(verify DB introspect 产物)在 Step J 成功 apply 后**不自动清理**,只在 verify 失败时作为排障入口保留。这两个目录对成功路径没价值,只占用 `out/` 目录。
- **建议**:Step J 走完成功路径后调 `cleanupDir(verifyMigDir)` + `cleanupDir(verifyIntroDir)`。失败路径继续保留。

## [plans/001-rebase-verify.md] 端到端跑测尚未实地验证

- **类型**:bug / 范围外发现
- **位置**:`src/hooks/rebase.ts` Step V
- **描述**:本机无 postgres + migra,所有需要外部依赖的验收项(V1/V2/V3 在真 DB 上跑通、admin 模式 `psql -l` 看到两个新库、构造 FK 缺 unique index 的故障注入)都未实地确认。代码层面静态 review 通过,但运行时可能踩到:
  - migra 实际 exit code 与文档不符(我按 0/2/3 处理 + 信任 stdout,应有兜底)
  - drizzle-kit migrate 对一个只有 0000 的 verifyDir 的行为(应直接 apply,但若 drizzle-kit 内部有"必须 ≥2 entries"假设会炸)
  - admin URL 指向 `template1` 时 `CREATE DATABASE` 会从 template1 clone,可能继承不期望的对象
- **建议**:在配齐 postgres + migra 的环境下跑一次 admin-mode 完整流程,确认 reminder 输出与三命题判定。失败时根据日志再回头修。

## [所有 plan 外] migra 安装提示文案

- **类型**:优化
- **位置**:`src/hooks/rebase.ts` `runMigra` ENOENT 分支
- **描述**:当前提示仅给 `pipx install migra` / `pip install migra psycopg2-binary`。Linux 用户可能还需 `apt-get install libpq-dev` 或 `apt-get install python3-psycopg2`;macOS 需要 `brew install libpq`(然后链 PATH)才能 pip install psycopg2。
- **建议**:在 README 而非错误提示里写清平台差异;错误提示保持简短。或者推荐 `pipx install migra[pg]`(如果存在 extras)。
