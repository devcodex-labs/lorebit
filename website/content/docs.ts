export type NavigationItem = {
  href: string;
  label: string;
};

export type NavigationGroup = {
  label: string;
  items: NavigationItem[];
};

export const navigationGroups: NavigationGroup[] = [
  {
    label: "开始",
    items: [
      { href: "/docs", label: "文档总览" },
      { href: "/docs/getting-started", label: "快速开始（预览）" },
    ],
  },
  {
    label: "核心概念",
    items: [
      { href: "/docs/concepts/rag-pipeline", label: "RAG pipeline" },
      { href: "/docs/concepts/knowledge-lifecycle", label: "知识生命周期" },
    ],
  },
  {
    label: "扩展与边界",
    items: [
      { href: "/docs/adapters", label: "数据库与索引适配" },
      { href: "/docs/roadmap", label: "路线图与非目标" },
    ],
  },
];

export const productClaims = [
  {
    eyebrow: "RAG-native",
    title: "完整主路径，不是零散 CRUD",
    body: "从内容进入、索引到可引用上下文交付，lorebit 关注开发者真正需要拼起来的整条知识链路。",
  },
  {
    eyebrow: "Provider-neutral",
    title: "数据库是适配器，不是产品边界",
    body: "向量、全文、文档、图和 checkpoint 可由不同后端实现；core 统一生命周期、执行计划与结果语义。",
  },
  {
    eyebrow: "Evidence-first",
    title: "把来源带到上下文里",
    body: "内容身份、revision 和 citation 会随着检索结果传播，方便上层应用解释“为什么命中”。",
  },
];

