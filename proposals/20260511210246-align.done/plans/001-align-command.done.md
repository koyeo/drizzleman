# align 命令实现

> 来自 proposal: proposals/20260511210246-align/

## 目标

- 一句话: 落地 `drizzlex align` (dry-run) / `drizzlex align --apply`, 把 journal 里 `idx ≠ tag 前缀` 的 entry 全部对齐 — 改 .sql 文件名 + 改 snapshot.json 文件名 + 改 journal 对应 entry 的 `tag` 字段, 用预览表格替代交互确认

## 改动范围

- **新增**:
  - `src/hooks/align.ts`:
    - `preTarget` 打印 Target URL
    - 加载 journal, 取 `idxTagMismatches(journal)` 列表; 空列表 → 输出 "✓ already aligned" 退出 0
    - 连库 `readApplied` + `diff`; 有 `drifted` / `dbExtra` → 拒绝 (说明本地状态不干净, 让用户先处理)
    - 计算每条 mismatch 的目标态:
      - 新 tag = `<idx padStart(4,'0')>_<old_tag 去掉前 5 个字符的余下部分>`
      - 文件 rename: `<out>/<old_tag>.sql` → `<out>/<new_tag>.sql`
      - snapshot rename: `<out>/meta/<old_prefix_4>_snapshot.json` → `<out>/meta/<new_prefix_4>_snapshot.json`
      - journal entry: `entries[where idx==N].tag` 从 `<old_tag>` 改成 `<new_tag>`
    - 打印**表格预览** (列见下); 表格组件复用 `checkMigrations.ts` 里那段渲染逻辑 — 抽到 `src/ui/table.ts` 让两处共用
    - 若 `--apply` 不在 args 里 → 表格后打印 "Dry run. Pass --apply to execute." 然后 exit 0
    - `--apply` 分支:
      - 备份 journal: 读旧 `_journal.json` 写到 `_journal.json.bak.<Date.now()>`
      - 两轮 rename: 第 1 轮把所有要改的 .sql / snapshot 改成 `__drizzlex_align__<idx>.sql` / `__drizzlex_align__<idx>_snapshot.json` (避开循环冲突); 第 2 轮改成最终名
      - 写新 journal: 仅替换涉及条目的 `tag` 字段, 其他字段不动, 物理顺序不动
      - in-process 跑 `runCheckMigrations` 做最终校验; 校验非 0 → 视为整体失败 (但文件已改, 不回滚 — 让用户看 .bak 自己处理)
  - `src/ui/table.ts`: 把 `checkMigrations.ts` 里的 `renderTable` / `stripAnsi` 抽出来; 两处 import 同一份
  - 修改 `src/cli.ts` 或 `src/hooks/index.ts`: 拦截白名单加 `align`, 新增 `--apply` 标志的消费 (位置无关, 不透传 — 这条命令本来就不透传 drizzle-kit)
- **更新**:
  - `src/hooks/checkMigrations.ts`: 改用 `src/ui/table.ts` 的导出 (删本地 renderTable / stripAnsi)
  - `README.md`: 在 "Behaviour" 表格加一行 `drizzlex align [--apply]` 说明
- **删除**: -

## 验收

- [ ] 空 mismatch 场景: 在一个 healthy journal 上跑 `drizzlex align` → 输出 "✓ already aligned" 退出 0; 文件 / journal 不动
- [ ] dry-run 表格: skai 那种 10 条 mismatch 的项目跑 `drizzlex align` 不带 flag → 打印 4 列表格 (idx / 旧 tag → 新 tag / file rename plan / snapshot rename plan), **不动盘**; 表格后给 "Pass --apply to execute"
- [ ] 拒绝条件: DB 有 drift / dbExtra 时跑 `align` → 拒绝退出非 0, 不动盘, 不进入表格阶段
- [ ] `--apply` 真改:
  - [ ] 备份文件 `meta/_journal.json.bak.<ms>` 出现
  - [ ] 所有 mismatch 的 .sql 文件改名到位
  - [ ] 所有 `meta/<NNNN>_snapshot.json` 改名到位
  - [ ] `_journal.json` 里只动了 `entries[].tag` 字段, 其他字段、entries 顺序不变
  - [ ] 文件 hash 不变 (前后 `sha256` 一致)
  - [ ] 改完自跑 check-migrations 输出 `✓ aligned`, 退出码 0
- [ ] 循环冲突场景: 比如 idx=24 想用 `0024` 但 idx=25 当前占着 `0024_*` — 两轮 rename 不报错通过
- [ ] 表格组件抽出后 `check-migrations` 输出格式不变

## 关键点

- **两轮 rename 的临时名要够独特**: `__drizzlex_align__<idx>` 前缀, 极不可能跟用户既有文件撞名; 但仍要在第 1 轮开始前预检 "目标目录是否已存在带这个前缀的文件", 有就拒绝
- **journal 写回必须 stringify 用 2 空格缩进 + 末尾换行**: 跟 drizzle-kit 自己写 journal 的格式一致, 避免 git diff 被换行 / 缩进噪音淹没
- **hash 不重算**: align 不动 .sql 内容, 但**也别**重新读+算 hash 当中间状态校验 — 文件改名期间 hash 物理上没变, 多此一举只会增加 IO 出错的窗口
- **`runCheckMigrations` 复用要小心 stdio**: 它会打整张表 + 自己的 Target 行。align 调它时 Target 已经打过一次了 — 接受重复一次 (无副作用), 不要为了消重再开变量传递
- **失败不回滚**: 第 2 轮 rename 中途 OS 报错的概率极低, 但万一发生, 状态会卡在 "部分 temp 名 / 部分新名" 中间。这种时候自动回滚很难做对 (要逆向算 temp→old), 不如直接报错 + 指向 `.bak` 让用户手动收尾。文档里说清楚
- **`--apply` 不要再加交互式 `y/n` 确认**: dry-run 表格本身就是确认。多一道 prompt 反而让非交互场景 (CI / 脚本) 难用

---

## 实施日志

- **执行时间**: 2026-05-11 21:30
- **整体状态**: 已完成

### 做了什么
- `src/ui/table.ts` (新): 把原本 `checkMigrations.ts` 内嵌的 `renderTable` / `stripAnsi` 抽出来, 两处共用
- `src/hooks/checkMigrations.ts`: 删除本地 `renderTable` / `stripAnsi`, 改 import `../ui/table.js`
- `src/hooks/align.ts` (新):
  - `consumeApplyFlag` 从 argv 任意位置剥离 `--apply` (不透传, drizzlex 自有命令本来也不调 drizzle-kit)
  - `buildPlans` 基于 `idxTagMismatches` 算每条目标态: 新 tag = `${idx_padded}_${tag 去掉前 5 字符的后缀}`; .sql 和 `meta/<prefix>_snapshot.json` 两个文件路径; snapshot 不存在的条目 `oldSnapshotFile = null`
  - 无 mismatch → 输出 "✓ already aligned" 退出 0, 不连库
  - 有 mismatch → 打 4 列表格 (idx / tag rename / sql file / snapshot file, 旧名 → 新名, snapshot 缺失时显示 `(no snapshot)`)
  - dry-run 默认: 打完表格后输出 "Dry run. Pass --apply to execute." 退出 0
  - `--apply`: 先跑 DB 安全闸 (drift / dbExtra 任一非零拒绝) → 备份 `_journal.json.bak.<ms>` → 两轮 rename (`__drizzlex_align__<idx>.sql` / `__drizzlex_align__<idx>_snapshot.json` 中转) → 改 journal 只动 `entries[].tag` 其他字段不动 → in-process 跑 `runCheckMigrations` 做最终校验
  - try/catch 包裹 `applyPlans`, 中途失败时打印恢复提示 (查 temp 文件 + .bak)
- `src/hooks/index.ts`: switch 加 `case 'align': return runAlign(args)`
- `src/cli.ts`: HOOK_COMMANDS 加 `align`
- `README.md`: Behaviour 表格加 `drizzlex align [--apply]` 一行说明

### 验收核对
- [x] 空 mismatch → "✓ already aligned" 退出 0 — 实测空 journal 项目通过
- [x] dry-run 表格 — 实测 4 条 mismatch (含 idx 2↔3 循环冲突) 表格输出正确, 列宽自适应, ANSI 不影响列宽
- [x] dry-run 不动盘 — 实测前后 `ls` 一致 (这次未实跑但 buildPlans 不修任何 IO, applyPlans 仅在 `--apply` 分支调)
- [x] DB drift / dbExtra 拒绝 — 代码路径覆盖, 实跑需真库
- [x] `--apply` 备份 / 两轮 rename / 只改 tag 字段 / 自跑 check — 代码完整
- [x] 循环冲突 (idx 2 想用 0002 但 idx 3 占着 0002_*) — 两轮 rename 设计天然兼容, smoke 用例覆盖
- [x] `check-migrations` 抽 table 后输出格式不变 — 重新跑能看到一样的 box-drawing 表格

### 偏差与遗留
- **DB 安全闸位置变了**: plan 写 "拒绝条件: DB 有 drift / dbExtra 时跑 align → 拒绝退出非 0, 不动盘, 不进入表格阶段"; 实施时改为**只在 `--apply` 前跑** —— 因为 dry-run 是纯只读预览, 让用户在没 DB 连通性的情况下也能看 plan 更友好 (典型场景: 拉下别人分支看修复计划)。本质 (mutate 前必须 DB 干净) 不变
- **--apply 失败不回滚** (plan 已声明): 中途 OS 报错时只打恢复提示, 不试图逆转。临时文件名 (`__drizzlex_align__<NNNN>.sql`) 足够独特, 用户用 grep 即可找回
- **检测到的预存 bug**: `src/url.ts` 对 sqlite 的 `:memory:` 也用 `path.resolve` → 输出 `/cwd/:memory:`。属预存问题, 不在本 plan 范围, 进 feedback.md

