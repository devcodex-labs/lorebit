# lorebit

> RAG knowledge infrastructure with provider-neutral storage adapters.

**Early Preview** — lorebit is being designed as a general-purpose, local-first RAG knowledge engine. It is not a database product, and it is not limited to DevCodex. The core SDK and the `@devcodex/lorebit` npm package are not published yet.

## What is being built

The intended user path is:

```text
source → ingest → normalize → chunk → embed/index
       → retrieve → rerank → context pack + citations
       → update / delete / reindex
```

The core will coordinate that lifecycle. Database and index backends are replaceable adapters; lorebit will not implement a database engine.

## Documentation

The Chinese-first preview documentation site lives in [`website/`](./website). It explains the product boundary, RAG pipeline, knowledge lifecycle, adapter model, and roadmap without presenting design proposals as released API.

## Status

- Product boundary: frozen for the initial implementation phase.
- Documentation site: initial preview in progress.
- Core SDK, database adapters, npm release: not part of this repository's first documentation-site delivery.

## License

Apache-2.0. See [LICENSE](./LICENSE).

