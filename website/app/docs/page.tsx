import Link from "next/link";

import { DocsShell } from "../../components/DocsShell";

export default function DocumentationIndex() {
  return (
    <DocsShell activeHref="/docs">
      <p className="eyebrow">文档总览</p>
      <h1>先看清 lorebit 的边界。</h1>
      <p className="docs-lede">
        lorebit 计划成为通用、local-first、provider-neutral 的 RAG 知识基础设施。这里先说明它解决的用户任务、
        如何与数据库后端协作，以及哪些部分仍在实现前的设计阶段。
      </p>

      <div className="reading-path">
        <article>
          <span>01</span>
          <h2>预期首次成功</h2>
          <p>理解未来的 ingest → retrieve → citation 路径，以及为什么现在不提供可复制安装命令。</p>
          <Link href="/docs/getting-started">开始阅读 →</Link>
        </article>
        <article>
          <span>02</span>
          <h2>RAG pipeline</h2>
          <p>识别 core 要编排的整条链路，而不是只关注某一个向量检索调用。</p>
          <Link href="/docs/concepts/rag-pipeline">查看 pipeline →</Link>
        </article>
        <article>
          <span>03</span>
          <h2>后端适配</h2>
          <p>了解数据库只做 adapter 的真正含义，以及 capability negotiation 为什么必要。</p>
          <Link href="/docs/adapters">查看适配边界 →</Link>
        </article>
      </div>

      <aside className="callout callout--preview">
        <h2>Early Preview 是什么？</h2>
        <p>
          本站可以作为产品边界和实现路线的公开参考，但不代表 `@devcodex/lorebit` 已发布、接口已经稳定，
          或任一数据库 provider 已被支持。
        </p>
      </aside>
    </DocsShell>
  );
}

