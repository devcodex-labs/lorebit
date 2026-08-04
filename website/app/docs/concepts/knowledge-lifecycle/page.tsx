import { DocsShell } from "../../../../components/DocsShell";

export default function KnowledgeLifecyclePage() {
  return (
    <DocsShell activeHref="/docs/concepts/knowledge-lifecycle">
      <p className="eyebrow">核心概念</p>
      <h1>更新知识时，检索不应看到半完成的世界。</h1>
      <p className="docs-lede">
        同一个 source 可能被重切 chunk、重新 embed、迁移索引或删除。lorebit 计划把这些变化建模为 revision
        与 activation，而不是让 query 在不同后端之间读到混合状态。
      </p>

      <div className="lifecycle-steps">
        <article>
          <span>01</span>
          <h2>接受 source revision</h2>
          <p>对输入内容建立确定的 identity，并记录本次 ingest 的 idempotency 与 receipt。</p>
        </article>
        <article>
          <span>02</span>
          <h2>构建候选 revision</h2>
          <p>document/chunk、embedding 与索引写入可以分阶段完成；失败部分保留为可重试状态。</p>
        </article>
        <article>
          <span>03</span>
          <h2>激活可检索版本</h2>
          <p>默认 query 只访问已激活 revision。只有核心一致性条件满足后，新索引才替换旧结果。</p>
        </article>
        <article>
          <span>04</span>
          <h2>删除、tombstone 与 repair</h2>
          <p>delete 不能只删一个向量；需要让 document、索引与 citation 共同停止产生幽灵召回。</p>
        </article>
      </div>

      <aside className="callout callout--preview">
        <h2>实现方向已冻结，具体 API 尚未冻结</h2>
        <p>
          source revision、activation、tombstone、repair/reindex 是产品要求。类型名、事务接口和 adapter receipt
          会在 core contract 阶段通过可执行测试后公开。
        </p>
      </aside>
    </DocsShell>
  );
}

