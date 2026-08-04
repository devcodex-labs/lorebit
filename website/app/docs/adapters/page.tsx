import { DocsShell } from "../../../components/DocsShell";

const adapterShape = `interface VectorIndexAdapter {
  capabilities(): Promise<VectorCapabilities>
  upsert(records, options): Promise<WriteReceipt>
  delete(input): Promise<WriteReceipt>
  search(input): Promise<VectorSearchResult>
  health(): Promise<AdapterHealth>
}`;

export default function AdaptersPage() {
  return (
    <DocsShell activeHref="/docs/adapters">
      <p className="eyebrow">扩展与边界</p>
      <h1>数据库只做适配，但 core 不能丢掉一致性责任。</h1>
      <p className="docs-lede">
        lorebit 不实现数据库引擎，也不直接绑定 PostgreSQL、Qdrant、Milvus、Pinecone 或 SQLite 的驱动。
        它通过版本化 contracts 接入后端，再用能力协商选择可解释的执行计划。
      </p>

      <div className="adapter-table" role="table" aria-label="lorebit adapter contracts">
        <div className="adapter-table__row adapter-table__row--heading" role="row">
          <span role="columnheader">Contract</span>
          <span role="columnheader">负责什么</span>
          <span role="columnheader">典型 provider</span>
        </div>
        <div className="adapter-table__row" role="row">
          <span role="cell">DocumentStoreAdapter</span>
          <span role="cell">document、chunk、metadata、source revision</span>
          <span role="cell">关系库、KV、文件存储</span>
        </div>
        <div className="adapter-table__row" role="row">
          <span role="cell">VectorIndexAdapter</span>
          <span role="cell">upsert、delete、similarity、filter</span>
          <span role="cell">Qdrant、pgvector、Milvus</span>
        </div>
        <div className="adapter-table__row" role="row">
          <span role="cell">LexicalIndexAdapter</span>
          <span role="cell">BM25 / full-text / lexical query</span>
          <span role="cell">FTS、搜索服务、数据库原生索引</span>
        </div>
        <div className="adapter-table__row" role="row">
          <span role="cell">GraphStoreAdapter</span>
          <span role="cell">entity/relation traversal（可选）</span>
          <span role="cell">图数据库或 relation store</span>
        </div>
        <div className="adapter-table__row" role="row">
          <span role="cell">CheckpointStoreAdapter</span>
          <span role="cell">job、cursor、idempotency、repair</span>
          <span role="cell">关系库、KV、任务存储</span>
        </div>
      </div>

      <h2>为什么必须先问 capabilities()</h2>
      <p>
        不同 provider 对 metadata filter、namespace、distance metric、delete-by-filter、原生 hybrid、事务和 schema
        migration 的支持不同。core 需要知道真实能力，决定组合多个 adapters、采用确定的 fallback，或明确失败。
      </p>

      <pre className="code-block" aria-label="概念性 VectorIndexAdapter 接口">
        <code>{adapterShape}</code>
      </pre>

      <aside className="callout callout--warning">
        <h2>不会静默降级</h2>
        <p>
          如果调用要求的 filter、hybrid 或 consistency 语义无法满足，lorebit 应给出确定的执行计划或错误；不能悄悄换成较弱检索再把它伪装成同一个结果。
        </p>
      </aside>
    </DocsShell>
  );
}

