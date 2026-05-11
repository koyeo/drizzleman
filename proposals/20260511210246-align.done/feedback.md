# Feedback

执行 proposal 期间冒出的、未在当前会话处理的事项。收尾后由用户决定要不要新开 proposal / plan 处理。

---

## [plans/001-align-command.done.md] url.ts 对 sqlite ':memory:' 错误地 resolve 成路径

- **类型**: bug
- **位置**: `src/url.ts` `targetUrl()`
- **描述**: 当前对 sqlite 一律 `path.isAbsolute(file) ? file : path.resolve(cwd, file)`, 导致 `:memory:` 这种特殊值被当成文件名拼接到 cwd 下, 输出 `/cwd/:memory:`
- **建议**: 特判 `file === ':memory:'` 直接输出 `:memory:`; 也可以扩展认 sqlite 的其他特殊形式 (`file::memory:?cache=shared` 等)。优先级低 (生产场景几乎不用 in-memory sqlite)

## [plans/001-align-command.done.md] align --apply 中途失败的回滚

- **类型**: 优化
- **位置**: `src/hooks/align.ts` `applyPlans()`
- **描述**: 当前 pass 1/pass 2 之间 OS 报错时, 留下一堆 `__drizzlex_align__<idx>.sql` 临时文件 + 未更新的 journal, 用户得自己手动恢复。这种情况发生概率极低 (rename 是原子操作, 主要看磁盘是否满), 但发生时恢复成本高
- **建议**: 加一个 `--rescue` 子动作: 扫描 `__drizzlex_align__*` 临时文件, 配对 .sql + snapshot, 通过文件名里的 idx 反推应该改成什么 (但临时名只编码了 idx, 没编码原 tag suffix... 可能要从 .bak 里查), 自动收尾。复杂度不低, 等真踩到再说

## [plans/001-align-command.done.md] align 提示中给出修复命令链路

- **类型**: UX
- **位置**: `src/hooks/align.ts` 多个 error log
- **描述**: 失败提示里只说"reconcile DB state first", 没说具体怎么 reconcile。比如 DB drift 时, 用户得手动判断是哪种 drift, 然后人工对齐
- **建议**: 给典型 case 的具体修复步骤 (drift → 检查 .sql 是否被改, 改回去 / 重新 generate; db-extra → 同步 .sql 文件; 等等)
