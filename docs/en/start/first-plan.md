# Your first adoption plan

<span class="lorebit-label">START HERE · DEFINE ONE REAL KNOWLEDGE PATH</span>

This is not an installation guide. lorebit has not published an npm package or stable API. The most useful first success today is defining one knowledge path that can later be verified.

## 1. Start with a real question

Choose a task that needs ongoing source citations, such as “answer a customer question from the latest product rules.” Do not begin with “I want to store vectors”: that chooses an implementation before choosing what the user needs.

Write down three things:

| Clarify | Example |
|---|---|
| What the user receives | An actionable answer and the rule it cites |
| Where evidence comes from | Reviewed help-center articles, policy pages, and versioned product docs |
| What counts as stale | The original is replaced, withdrawn, or superseded by a new version |

## 2. Define the smallest knowledge workflow

<div class="lorebit-flow">
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">01</span><strong>Sources</strong><p>Know which sources can enter the knowledge base and who owns them.</p></div>
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">02</span><strong>Queries</strong><p>Define the questions users ask and the evidence standard each answer must meet.</p></div>
  <div class="lorebit-flow__step lorebit-flow__step--citation"><span class="lorebit-flow__eyebrow">03</span><strong>Citations</strong><p>Decide how an answer points back to a document fragment, version, and original source.</p></div>
</div>

Until these three points are clear, swapping vector stores will not make a knowledge answer more reliable.

## 3. Keep storage at the adapter boundary

List the capabilities you actually need: source preservation, semantic retrieval, keyword retrieval, relationship traversal, or rebuild checkpoints. lorebit aims to coordinate those capabilities, not to implement a database kernel for you.

See [database and index adapters](/en/adapters/database-adapters).

## 4. Wait for a verifiable public entry point

Until the public SDK ships, do not treat the terms in these docs as callable class names or configuration fields. This page will be replaced with a runnable minimal path and failure-recovery guidance when that entry point exists.

Next: [understand the RAG workflow](/en/concepts/rag-pipeline).
