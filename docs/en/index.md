---
pageType: home
hero:
  name: lorebit
  text: General-purpose knowledge infrastructure for RAG
  tagline: Organize sources, retrieval, context, and citations into an evolvable knowledge workflow. DevCodex is one consumer; databases enter only through adapters.
  actions:
    - theme: brand
      text: Make an adoption plan
      link: /en/start/first-plan
    - theme: alt
      text: Understand the RAG workflow
      link: /en/concepts/rag-pipeline
    - theme: alt
      text: See the adapter boundary
      link: /en/adapters/database-adapters
features:
  - title: Start with trustworthy evidence
    details: Begin with sources, versions, and citations instead of forcing data into a particular vector database.
    link: /en/concepts/knowledge-lifecycle
  - title: RAG is the primary path
    details: Ingestion, normalization, retrieval, reranking, context, and citations form one continuous workflow.
    link: /en/concepts/rag-pipeline
  - title: Storage capabilities stay replaceable
    details: Documents, vectors, full text, graphs, and checkpoints are attached through explicit adapter capabilities.
    link: /en/adapters/database-adapters
  - title: Promise only what exists
    details: This is an Early Preview. There is no published npm package, stable API, or database kernel implementation.
    link: /en/reference/preview-status
---

<span class="lorebit-label">EARLY PREVIEW · USER DOCS FIRST</span>

> **Current status:** lorebit has not published an npm package or stable API. This site explains the product boundary and adoption path; it does not turn design drafts into installable APIs.

## What kind of problem comes first

lorebit is for products that must continuously retrieve evidence from source material, deliver answers together with their provenance, and evolve knowledge as the original material changes. It is not a database product and not an internal module for one host.

Start with a first adoption plan to establish the boundary around sources, queries, and updates. Decide whether to wait for a public SDK only after that path is clear.

## User path

1. Name one real task the knowledge system must answer.
2. Identify the source material, update cadence, and evidence each answer must return.
3. Choose storage capabilities instead of presuming one database.
4. When the public SDK exists, turn that path into a testable ingestion and retrieval workflow.

Next: [make your first adoption plan](/en/start/first-plan).
