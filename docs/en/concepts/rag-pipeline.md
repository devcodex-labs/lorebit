# RAG workflow

<span class="lorebit-label">CORE CONCEPT · RETRIEVAL IS A FLOW, NOT A TABLE</span>

RAG is lorebit's primary product path: a question becomes an evidence-backed answer through a sequence that preserves source identity and makes each decision inspectable.

## The path from material to an answer

<div class="lorebit-flow">
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">01</span><strong>Ingest</strong><p>Collect approved material with source ownership and version information.</p></div>
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">02</span><strong>Normalize</strong><p>Turn it into addressable units without losing the link to the original.</p></div>
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">03</span><strong>Retrieve</strong><p>Use the capabilities needed for a question: semantic, lexical, or structured.</p></div>
  <div class="lorebit-flow__step lorebit-flow__step--citation"><span class="lorebit-flow__eyebrow">04</span><strong>Ground</strong><p>Build context and citations that let a reader verify the answer.</p></div>
</div>

Reranking, filtering, and context assembly belong in this flow because they affect what evidence reaches the answer. A vector index can help with one step; it is not the system boundary.

## What a good result preserves

| Property | Why it matters |
|---|---|
| Source identity | A reader can find the original material behind a claim. |
| Version awareness | A result can be reconsidered when a source changes. |
| Retrieval rationale | Operators can understand why evidence was chosen. |
| Citation-ready context | The final answer can expose evidence rather than merely sounding confident. |

## What this does not promise yet

These docs describe the intended workflow, not a released SDK contract. Names, interfaces, and provider support remain preview material until an implementation and compatibility policy are published.

Continue with [the knowledge lifecycle](/en/concepts/knowledge-lifecycle).
