---
pageType: home
hero:
  name: lorebit
  text: 面向 RAG 的通用知识基础设施
  tagline: 把资料、检索、上下文与引用组织为可演进的知识工作流；DevCodex 只是一个消费者，数据库只通过 adapter 接入。
  actions:
    - theme: brand
      text: 先制定采用计划
      link: /start/first-plan
    - theme: alt
      text: 理解 RAG 工作流
      link: /concepts/rag-pipeline
    - theme: alt
      text: 查看 Adapter 边界
      link: /adapters/database-adapters
features:
  - title: 先把证据做对
    details: 从资料来源、版本和引用开始，而不是先把数据塞进某一种向量数据库。
    link: /concepts/knowledge-lifecycle
  - title: RAG 是主路径
    details: 摄取、规范化、检索、重排、上下文和 citation 是一个连续工作流。
    link: /concepts/rag-pipeline
  - title: 存储能力可替换
    details: 文档、向量、全文、图与检查点都通过能力明确的 adapter 接入。
    link: /adapters/database-adapters
  - title: 只承诺已存在的事实
    details: 当前是 Early Preview；没有 npm 包、稳定 API 或数据库内核实现。
    link: /reference/preview-status
---

<span class="lorebit-label">EARLY PREVIEW · 用户文档先行</span>

> **当前状态：** lorebit 的核心 SDK 和 `@devcodex/lorebit` npm 包尚未发布。本网站说明产品边界与采用路径，不把设计草案写成可安装 API。

## 先解决哪类问题

lorebit 适合需要持续从资料中检索证据、把答案和来源一起交付、并让知识随着原始资料更新的产品。它不是数据库产品，也不是只服务某一个宿主的内部模块。

你可以先从“第一次采用计划”开始，确认自己的资料、查询和更新边界；再决定是否等待公开 SDK 接入。

## 用户路径

1. 明确一个要被知识系统回答的真实任务。
2. 确认资料来源、更新频率和答案必须带回的证据。
3. 选择需要的存储能力，而不是预设某一个数据库。
4. 在公开 SDK 可用后，把这一条路径变成可验证的摄取与检索工作流。

下一步：[制定第一次采用计划](/start/first-plan)。
