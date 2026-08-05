# 第一次采用计划

<span class="lorebit-label">开始之前 · 先确定一条真实知识路径</span>

本页不是安装教程。lorebit 尚未发布 npm 包或稳定 API；现在最有价值的“第一次成功”是把一条以后能验证的知识路径定义清楚。

## 1. 从一个真实问题开始

选择一个需要持续引用资料的任务，例如“根据最新产品规则回答客户问题”。不要从“我想存向量”开始，因为那会过早决定实现，而不是决定用户需要得到什么。

写下三件事：

| 需要明确 | 示例 |
|---|---|
| 用户要得到什么 | 一段可执行的回答，并知道它引用了哪份规则 |
| 证据来自哪里 | 已审核的帮助中心、政策页和版本化产品文档 |
| 什么算过期 | 原文被替换、撤回，或新版本生效 |

## 2. 定义最小知识工作流

<div class="lorebit-flow">
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">01</span><strong>资料</strong><p>知道哪些来源可以进入知识库，以及谁负责它们。</p></div>
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">02</span><strong>查询</strong><p>定义用户会问的问题和答案必须满足的证据标准。</p></div>
  <div class="lorebit-flow__step lorebit-flow__step--citation"><span class="lorebit-flow__eyebrow">03</span><strong>引用</strong><p>规定答案如何回到文档片段、版本和原始来源。</p></div>
</div>

只要这三项没有说清，换任何向量库都不会让知识回答更可靠。

## 3. 把存储留在 adapter 边界

先列出你真正需要的能力：原文保存、语义检索、关键词检索、关系遍历或重建检查点。lorebit 的目标是协调这些能力，而不是替你实现数据库内核。

参见：[数据库与索引适配器](/adapters/database-adapters)。

## 4. 等待可验证的公开入口

公开 SDK 发布前，请不要把本文的术语当成可调用的类名或配置字段。届时本页会替换为一条可运行、带错误恢复说明的最小接入路径。

下一步：[理解 RAG 工作流](/concepts/rag-pipeline)。
