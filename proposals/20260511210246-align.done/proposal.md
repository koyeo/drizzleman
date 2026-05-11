# drizzlex align: 把 tag 前缀对齐到 idx

> Created: 2026-05-11

## 背景与目标

- 跨分支合并 / 手动改动 journal 后, `_journal.json` 里会出现 `entries[].idx ≠ int(tag.split('_')[0])` 的"错位"。drizzle-kit 自己不报错, 但下次 `generate` 产出的新文件前缀会跟磁盘已有文件号撞车, 视觉上一团乱
- 当前 drizzlex `generate` hook 已能**检测**这个错位并阻塞, 但只能阻塞、不能修。用户得手改 10 几个文件 + 改 journal + 重命名 snapshot, 容易漏
- 目标: 提供一个**新子命令 `drizzlex align`** (短名), 自动把 tag 前缀向 idx 对齐 — 重命名 `.sql` 文件 + 重命名 `meta/<prefix>_snapshot.json` 文件 + 改 journal 对应 entry 的 `tag` 字段。SQL 内容、hash、DB 一字不动
- 完成的可观测信号:
  - `drizzlex align` 不带 flag → 列出"将要重命名 / 修改"的表格, **不动盘**
  - `drizzlex align --apply` → 真改; 改完自跑一次 `check-migrations`, 输出 `✓ aligned`, 退出码 0
  - 改完再跑 `drizzlex generate` 不再被错位检查阻塞

## 范围

- **包含**:
  - 新 hook 命令 `align` (拦截白名单加这一条; 完全不调 drizzle-kit, drizzlex 自有命令)
  - 默认 dry-run, 输出**表格**预览每条 mismatch 的: 旧 tag / 新 tag / 旧 .sql / 新 .sql / 旧 snapshot / 新 snapshot
  - `--apply` 真改; 改前自动备份 `meta/_journal.json` → `meta/_journal.json.bak.<unix-ms>`
  - 两轮 rename (临时名中转) 避开文件名循环冲突
  - 改完自跑 check 校验
- **不包含**:
  - 不改 `.sql` 文件内容 (会破坏 hash)
  - 不动 DB
  - 不改 `entries[].when` (drizzle-orm 不读 when 决定顺序, 改它没必要也徒增 diff)
  - 不重排 entries 数组顺序 (drizzle-kit 自己读时按 idx 排, 物理顺序不影响行为)
  - 不重新生成 `migrations.js` bundle (用了 bundle 的用户改完后跑一次 `drizzle-kit generate --bundle` 即可)
  - 不处理跨分支同步 (别的分支引用旧 tag 是 git 问题, 不归这个 CLI 管)

## 关键决策

- **命令名定为 `align`** (3 字母, 单词): 与 drizzle-kit 自家命令风格一致 (generate/migrate/push/studio/check/up/drop), 不用 `reconcile-tags` 这种带破折号的长名。`align` 一词直接说明意图 "把两边对齐"
- **默认 dry-run, 必须 `--apply` 才真改**: 这条命令会重命名 10+ 文件, 风险够大, 默认走最保守的预览; `--apply` 不要再加交互式确认 (dry-run 表格已经是确认)
- **预览表格 4 列, 编号 + 改动定位**: idx (4 位补零) / 旧 tag → 新 tag / 文件操作 (移动两个文件) / journal 改动 (改一条 entry)。表格用与 check-migrations 同款 box-drawing 表格组件
- **两轮 rename 而非拓扑排序**: 先把所有要改的文件改成 `__drizzlex_align__<idx>.sql` / `__drizzlex_align__<idx>_snapshot.json`, 再把 temp 改成最终名。简单粗暴, 不需要算依赖图就避开了循环冲突
- **预检三道闸**: ① 连库读 `__drizzle_migrations` 跑 diff, 若有 `drifted` 或 `dbExtra` → 拒绝 (说明本地 .sql 内容跟 DB 不一致, 此时改文件名风险升高); ② 若没有任何 mismatch → 输出"已对齐"直接 exit 0, 不做任何动作; ③ `--apply` 前自动备份 journal
- **改完自动 check-migrations**: 用 `--apply` 跑完后 in-process 跑 `runCheckMigrations`, 失败就视为整体失败 (退出码非 0)。给用户一颗"成功"的确认信号

## Plans 拆分

| 编号 | 标题 | 路径 | 依赖 | 状态 |
|---|---|---|---|---|
| 001 | align 命令实现 | `plans/001-align-command.done.md` | - | 已完成 |
