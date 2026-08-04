import { DocsShell } from "../../../components/DocsShell";
import { StatusBadge } from "../../../components/StatusBadge";

export default function RoadmapPage() {
  return (
    <DocsShell activeHref="/docs/roadmap">
      <p className="eyebrow">扩展与边界</p>
      <h1>路线图是一组承诺边界，不是发布日期承诺。</h1>
      <p className="docs-lede">
        当前优先目标是可验证的端到端 RAG 主路径和 provider-neutral contracts。下面区分已经冻结的产品判断、下一阶段实现目标与明确不纳入的范围。
      </p>

      <div className="roadmap">
        <section>
          <div className="roadmap__heading">
            <StatusBadge tone="stable">已冻结</StatusBadge>
            <h2>产品边界</h2>
          </div>
          <ul>
            <li>通用、local-first、provider-neutral 的 RAG 知识引擎。</li>
            <li>完整链路：ingest → index → retrieve → context + citations。</li>
            <li>数据库只做适配；core 不实现数据库内核或绑定具体驱动。</li>
            <li>DevCodex 是消费者，不是产品边界。</li>
          </ul>
        </section>
        <section>
          <div className="roadmap__heading">
            <StatusBadge>下一阶段</StatusBadge>
            <h2>可执行 core contract</h2>
          </div>
          <ul>
            <li>document / chunk / evidence / citation 模型与 deterministic identity。</li>
            <li>loader、embedder、vector、lexical、reranker 的 provider contracts。</li>
            <li>reference memory backend、hybrid retrieval 与 lifecycle 测试。</li>
            <li>黄金集质量指标与 update/delete/reindex 的 stale-result 负向测试。</li>
          </ul>
        </section>
        <section>
          <div className="roadmap__heading">
            <span className="status-badge status-badge--quiet">本阶段不做</span>
            <h2>避免无边界扩张</h2>
          </div>
          <ul>
            <li>分布式向量数据库内核、WAL、分片、复制、备份与集群一致性。</li>
            <li>大规模 provider 包目录、托管 HTTP 服务、多租户鉴权和 dashboard。</li>
            <li>GraphRAG 自动实体抽取、多模态 embedding 或固定 LLM 冲突裁决。</li>
            <li>npm 发布、稳定 API 或具体发布日期。</li>
          </ul>
        </section>
      </div>

      <aside className="callout">
        <h2>文档会如何演进</h2>
        <p>
          每个“下一阶段”条目只有在对应实现、测试和公共契约一同成立后，才会从 Preview 文案变成真实安装与 API 文档。
        </p>
      </aside>
    </DocsShell>
  );
}

