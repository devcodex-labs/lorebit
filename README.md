# lorebit

> 面向 RAG 工作流、使用 provider-neutral 存储适配器的通用知识工作流基础设施。

**Early Preview** — lorebit 面向通用、local-first 的 RAG 知识工作流；它不是数据库产品，也不局限于 DevCodex。核心 SDK 和 `@devcodex/lorebit` npm 包尚未发布。

## 它解决什么问题

面向使用者的主路径是：

```text
source → ingest → normalize → chunk → embed/index
       → retrieve → rerank → context pack + citations
       → update / delete / reindex
```

core 将协调这条生命周期。数据库与索引后端是可替换的 adapter；lorebit 不会实现数据库内核。

更具体地说，lorebit 要让使用者能够定义问题与范围、审阅资料、看见处理状态、交付带来源和版本的回答，并在资料变化或能力不足时保持可解释的边界。它不把“能存向量”当作可信知识工作流的同义词。

## 使用文档

公开站暂时只提供简体中文，内容真相源在 [`docs/zh/`](./docs/zh)。英文翻译资产仍保留在 [`docs/en/`](./docs/en)，但不生成公开路由。使用者应从 [lorebit 是什么](https://devcodex-labs.github.io/lorebit/) 开始，依次完成问题定义、知识空间与回答合同、资料准入、第一条流程、带证据回答、资料变化和质量恢复。

站点把“当前事实”与“0.x 目标行为合同”分开：今天没有可安装的 SDK；目标合同则定义后续实现必须兑现的用户结果与验收场景。未来开发必须从 [0.x 目标行为合同](./docs/zh/reference/behavior-contract.md) 和 [用户场景验收](./docs/zh/reference/acceptance-scenarios.md) 派生，而不是先定 API 再倒推用户路径。

## 当前状态

- 产品边界：已冻结，RAG 是首要工作流；存储只通过 adapter 接入。
- 文档站：Rspress + GitHub Pages 预览；19 页中文用户任务路径与 0.x 行为合同已冻结。
- 核心 SDK、数据库 adapter 与 npm 发布：尚未提供。

## License

Apache-2.0. See [LICENSE](./LICENSE).
