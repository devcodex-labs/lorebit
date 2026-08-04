import { DocsShell } from "../../../../components/DocsShell";
import { KnowledgeFlow } from "../../../../components/KnowledgeFlow";

export default function RagPipelinePage() {
  return (
    <DocsShell activeHref="/docs/concepts/rag-pipeline">
      <p className="eyebrow">核心概念</p>
      <h1>RAG pipeline 是用户路径，不是一个向量查询。</h1>
      <p className="docs-lede">
        若一个库只统一 `similaritySearch`，应用仍要自行处理 source、chunk、index revision、rerank、context budget 和引用。
        lorebit 的产品边界从内容进入，一直到带来源的 context pack。
      </p>

      <KnowledgeFlow />

      <div className="article-grid">
        <section>
          <h2>进入与索引</h2>
          <p>
            loader/connector 提供 source；normalize 与 chunk 产生可寻址单元；embedder 和 index adapters 负责各自的表示与持久化。
            core 需要把 source revision、chunk identity 与 index revision 连起来。
          </p>
        </section>
        <section>
          <h2>检索与重排</h2>
          <p>
            vector、lexical、metadata 和未来的 graph 信号不必来自同一个后端。core 选择执行计划、融合分数，
            并把不支持的语义明确暴露，而不是静默替换检索方式。
          </p>
        </section>
        <section>
          <h2>上下文与引用</h2>
          <p>
            context pack 受 token budget、去重、多样性和来源分组约束。citation 必须随结果传播，
            让上层应用知道一段内容来自哪个 source 和 revision。
          </p>
        </section>
      </div>

      <aside className="callout">
        <h2>lorebit 不做什么</h2>
        <p>
          它不拥有最终生成模型回答，也不固定某个 LLM 作为事实抽取或冲突裁决策略。这些是上层应用或可插拔 pipeline
          policy 的选择。
        </p>
      </aside>
    </DocsShell>
  );
}

