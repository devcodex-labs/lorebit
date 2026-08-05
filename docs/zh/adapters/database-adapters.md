# 数据库与索引适配器

<span class="lorebit-label">适配与边界 · 数据库只做 adapter</span>

lorebit 不会从零实现数据库内核。它会根据每种存储的真实能力，通过 adapter 组合知识工作流；不能完成的能力必须显式暴露，而不是悄悄降级。

## 适配器分层

| Adapter | 它负责什么 | lorebit core 仍负责什么 |
|---|---|---|
| DocumentStore | 保存原文、元数据与版本 | identity、revision 与激活决策 |
| VectorIndex | 语义候选检索 | 查询编排、结果解释与 citation |
| LexicalIndex | 关键词、过滤或精确匹配 | hybrid 策略与缺失能力处理 |
| GraphStore | 关系或路径查询 | 领域语义与跨 adapter 一致性 |
| CheckpointStore | 摄取、重建与恢复进度 | 幂等、重试与失败状态机 |

## 能力协商比“支持某数据库”更重要

同一个数据库产品可能只启用了部分索引、过滤或事务能力。因此 adapter 应声明 capabilities，core 再据此决定一条查询或重建路径是否可执行。

这让使用者能看见选择的代价：例如只有向量检索时，系统可以明确说明关键词匹配不可用；而不是把结果变化伪装成正常行为。

## 不属于 adapter 的事

- 决定哪一份 revision 当前有效。
- 在部分失败后协调重试或重建。
- 把检索结果组织成带来源的上下文。
- 把 DevCodex 或其他宿主当成唯一产品边界。

下一步：[查看当前公开契约](/reference/preview-status)。
