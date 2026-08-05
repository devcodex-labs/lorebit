# Database and index adapters

<span class="lorebit-label">BOUNDARY · DATABASES ARE ADAPTERS, NOT THE PRODUCT</span>

lorebit is not trying to become a vector database. A database, search engine, graph store, or file system can provide a capability behind an adapter; lorebit's concern is the knowledge workflow that composes those capabilities.

## Choose capabilities, not a default database

| Capability | Questions to ask |
|---|---|
| Source persistence | Can the original material and its version be retained and traced? |
| Semantic retrieval | Can relevant meaning be retrieved for a query? |
| Lexical retrieval | Can exact terminology, identifiers, and filters be found? |
| Relationships | Can useful links and hierarchy be traversed when needed? |
| Rebuild checkpoints | Can derived indexes be refreshed without losing the source record? |

An adopter may need one provider for all of these, or several providers. Both are valid if the adapter contract expresses what the workflow needs and keeps provider-specific choices localized.

## The stable boundary we are aiming for

The public contract should describe observable capabilities and failure behavior, not force every consumer to adopt one storage engine. That keeps lorebit useful to DevCodex and to products with different operational constraints.

No adapter API is published yet. Treat this page as an architectural decision record, not an integration reference.

Next: [preview status and public contract](/en/reference/preview-status).
