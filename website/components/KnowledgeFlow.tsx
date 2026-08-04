const flowSteps = [
  "source",
  "ingest",
  "normalize",
  "chunk",
  "embed / index",
  "retrieve",
  "rerank",
  "context + citations",
];

export function KnowledgeFlow() {
  return (
    <ol className="knowledge-flow" aria-label="lorebit RAG pipeline">
      {flowSteps.map((step, index) => (
        <li key={step}>
          <span className="knowledge-flow__index">{String(index + 1).padStart(2, "0")}</span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

