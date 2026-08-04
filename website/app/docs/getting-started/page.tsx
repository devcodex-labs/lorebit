import { DocsShell } from "../../../components/DocsShell";
import { StatusBadge } from "../../../components/StatusBadge";

const proposal = `const knowledge = await createLorebit({
  embedder,
  adapters: {
    documents,
    vectors,
    lexical,
  },
});

await knowledge.ingest({
  source: "./docs",
  namespace: "product",
});

const result = await knowledge.retrieve({
  query: "退款策略是什么？",
  strategy: "hybrid",
  includeCitations: true,
});`;

export default function GettingStartedPage() {
  return (
    <DocsShell activeHref="/docs/getting-started">
      <div className="document-status-row">
        <StatusBadge>Early Preview</StatusBadge>
        <span>conceptual workflow only</span>
      </div>
      <p className="eyebrow">快速开始（预览）</p>
      <h1>未来的第一次成功，会是一条可解释的知识路径。</h1>
      <p className="docs-lede">
        目标不是“把文本塞进某个库”，而是在很短的应用代码路径内完成内容进入、检索和 citation 输出，并在后端替换时不改变业务调用。
      </p>

      <aside className="callout callout--warning">
        <h2>尚不能安装或运行</h2>
        <p>
          `@devcodex/lorebit` 还没有发布。下面的代码是 API Proposal，用来解释目标体验；它不是可复制执行的安装教程。
        </p>
      </aside>

      <h2>预期 workflow</h2>
      <ol className="numbered-list">
        <li>选择 embedder 和所需的 document / vector / lexical adapters。</li>
        <li>给一个 source 与 namespace，执行 ingest；系统保留 source revision 和可重试 receipt。</li>
        <li>使用自然语言 query 做 hybrid retrieval，并取得结果、score、matched-by 与 citations。</li>
        <li>由你的 Agent 或应用决定如何生成最终回答；lorebit 只交付上下文和引用。</li>
      </ol>

      <h2>概念性接口形状</h2>
      <pre className="code-block" aria-label="概念性 lorebit 接口示例">
        <code>{proposal}</code>
      </pre>

      <p className="document-note">
        进入 core 实现时，本文会替换为可验证的安装步骤、最小示例、版本要求和兼容性矩阵。
      </p>
    </DocsShell>
  );
}

