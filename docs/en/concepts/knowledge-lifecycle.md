# Knowledge lifecycle

<span class="lorebit-label">CORE CONCEPT · KNOWLEDGE CHANGES WITH ITS SOURCES</span>

Knowledge is not static after ingestion. lorebit treats source material, derived retrieval units, and answer citations as a lifecycle that must survive updates, withdrawals, and rebuilds.

## Lifecycle stages

1. **Register** a source and its owner, origin, and update expectations.
2. **Capture** a version that can be traced back to the original material.
3. **Derive** retrieval-ready units while retaining source and version links.
4. **Serve** evidence for a query through the appropriate retrieval capabilities.
5. **Reconcile** derived material when a source changes, disappears, or is corrected.

<div class="lorebit-flow">
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">SOURCE</span><strong>Versioned material</strong><p>Ownership and provenance remain attached to the original.</p></div>
  <div class="lorebit-flow__step"><span class="lorebit-flow__eyebrow">DERIVED</span><strong>Retrieval units</strong><p>Chunks, indexes, and relations are rebuildable artifacts, not the source of truth.</p></div>
  <div class="lorebit-flow__step lorebit-flow__step--citation"><span class="lorebit-flow__eyebrow">ANSWER</span><strong>Verifiable citations</strong><p>Every response can show which evidence and version informed it.</p></div>
</div>

## Why adapters matter here

Different stores can own different derived artifacts. The lifecycle therefore asks for capabilities—such as preserving a source, querying full text, or rebuilding a semantic index—rather than making one database a permanent architectural dependency.

See [database and index adapters](/en/adapters/database-adapters).
