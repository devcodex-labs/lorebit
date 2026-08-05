# RAG 工作流：从资料到可引用的上下文

<span class="lorebit-label">核心概念 · RAG 是连续路径，不是单次向量查询</span>

一个可靠的回答不只是“找到了相似文本”。它还要说明哪些资料被允许使用、当前版本是什么、哪些片段支撑了答案，以及资料变化后如何修正结果。

<div class="lorebit-flow">
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">01</span><strong>摄取</strong><p>读取允许进入的资料，并保留来源与版本。</p></div>
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">02</span><strong>规范化与切分</strong><p>形成可以检索、更新和定位的知识单元。</p></div>
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">03</span><strong>检索与重排</strong><p>结合语义、关键词或其他能力，挑出最相关的证据。</p></div>
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">04</span><strong>上下文包</strong><p>让下游模型或应用获得有限、可解释的上下文。</p></div>
  <div class="lorebit-flow__step lorebit-flow__step--citation"><span class="lorebit-flow__eyebrow">05</span><strong>引用</strong><p>把回答连回来源、片段和版本，而不是只返回一段无来源文本。</p></div>
</div>

## 为什么不要把它缩成“向量数据库”

向量索引只覆盖检索中的一部分。它不能独立决定资料是否有效、旧版本如何撤回、关键词与语义检索如何协作，或引用要怎样回到原文。

lorebit 的 core 应拥有这些工作流责任；底层存储只负责自己声明过的能力。

## 用户要检查什么

- 回答能否说明它依赖了哪些资料？
- 原始资料更新后，旧答案怎样失效或重建？
- 某一类索引不具备能力时，系统是否明确说明，而不是静默换一种行为？

下一步：[查看知识生命周期](/concepts/knowledge-lifecycle)。
