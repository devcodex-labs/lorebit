import Link from "next/link";

import { KnowledgeFlow } from "../components/KnowledgeFlow";
import { SiteHeader } from "../components/SiteHeader";
import { StatusBadge } from "../components/StatusBadge";
import { productClaims } from "../content/docs";

export default function Home() {
  return (
    <>
      <SiteHeader current="home" />
      <main id="main-content">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__content">
            <StatusBadge>Early Preview · API 设计中</StatusBadge>
            <p className="eyebrow">RAG knowledge infrastructure</p>
            <h1 id="hero-title">
              从知识进入到可引用上下文，
              <span>把 RAG 主路径做成一个清晰的模块。</span>
            </h1>
            <p className="hero__lede">
              lorebit 面向 AI 应用、Agent 与知识产品开发者：它编排 ingest、索引、检索、重排与 citation，
              但不把你的系统锁进某个向量数据库或 DevCodex 场景。
            </p>
            <div className="hero__actions">
              <Link className="button button--primary" href="/docs">
                阅读产品文档 <span aria-hidden="true">→</span>
              </Link>
              <a
                className="button button--quiet"
                href="https://github.com/devcodex-labs/lorebit"
                target="_blank"
                rel="noreferrer"
              >
                查看 GitHub <span aria-hidden="true">↗</span>
              </a>
            </div>
            <p className="hero__truth">
              <strong>真实状态：</strong>npm 包尚未发布；页面中的接口形状仅用于说明设计方向。
            </p>
          </div>
          <div className="hero__visual" aria-label="知识碎片汇聚为可引用上下文">
            <div className="signal signal--one" />
            <div className="signal signal--two" />
            <div className="signal signal--three" />
            <div className="knowledge-orbit knowledge-orbit--outer" />
            <div className="knowledge-orbit knowledge-orbit--inner" />
            <div className="knowledge-core">
              <span>lore</span>
              <strong>bit</strong>
            </div>
            <p>evidence → context</p>
          </div>
        </section>

        <section className="section section--claims" aria-labelledby="claims-title">
          <div className="section-heading">
            <p className="eyebrow">产品边界</p>
            <h2 id="claims-title">完整，但不吞掉基础设施。</h2>
            <p>
              lorebit 的职责是给上层产品一个稳定的知识生命周期和检索语义。数据库、索引与 provider
              在 contract 后面替换；生成模型回答仍属于你的应用。
            </p>
          </div>
          <div className="claim-grid">
            {productClaims.map((claim, index) => (
              <article className="claim-card" key={claim.title}>
                <span className="claim-card__number">0{index + 1}</span>
                <p className="claim-card__eyebrow">{claim.eyebrow}</p>
                <h3>{claim.title}</h3>
                <p>{claim.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section pipeline-section" aria-labelledby="pipeline-title">
          <div className="section-heading section-heading--split">
            <div>
              <p className="eyebrow">一条用户能走通的路径</p>
              <h2 id="pipeline-title">从 source 到 context + citations。</h2>
            </div>
            <p>
              不把“有向量搜索”误当成完整 RAG。lorebit 计划把每一段的 revision、结果语义和 citation
              一起管理。
            </p>
          </div>
          <KnowledgeFlow />
        </section>

        <section className="section boundary-section" aria-labelledby="boundary-title">
          <div className="boundary-section__copy">
            <p className="eyebrow">数据库只做适配</p>
            <h2 id="boundary-title">core 编排知识，adapter 对接后端。</h2>
            <p>
              lorebit 不自建 WAL、HNSW 持久化、复制、分片或集群一致性。它定义并使用文档、向量、全文、图和
              checkpoint 等 adapter contract；同一个 provider 可以覆盖多个 contract。
            </p>
            <Link className="text-link" href="/docs/adapters">
              了解 adapter 边界 <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className="boundary-grid" aria-label="core 与 adapter 的责任对照">
            <div>
              <p>lorebit core</p>
              <ul>
                <li>content identity 与 revision</li>
                <li>ingestion receipt 与 reindex</li>
                <li>hybrid plan、citation 与 repair</li>
              </ul>
            </div>
            <div>
              <p>provider adapters</p>
              <ul>
                <li>向量 / 全文 / 文档持久化</li>
                <li>能力协商与原生查询</li>
                <li>连接、驱动、迁移与兼容矩阵</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="section final-cta" aria-labelledby="cta-title">
          <p className="eyebrow">从产品边界开始</p>
          <h2 id="cta-title">先理解承诺，再决定是否参与。</h2>
          <p>文档会随着 core contract 的实现而更新；当前不会用概念图替代已经可以运行的 SDK。</p>
          <Link className="button button--primary" href="/docs/getting-started">
            查看预期首次成功 <span aria-hidden="true">→</span>
          </Link>
        </section>
      </main>
      <footer className="site-footer">
        <p>lorebit 是设计中的通用 RAG 知识基础设施。</p>
        <p>Apache-2.0 · API 与 npm 包尚未发布</p>
      </footer>
    </>
  );
}
