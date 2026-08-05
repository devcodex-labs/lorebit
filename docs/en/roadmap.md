# Roadmap

<span class="lorebit-label">NEXT · MAKE THE FIRST PUBLIC CONTRACT EARNED</span>

The roadmap is organized around user-verifiable milestones rather than a promise to ship a particular database or an unbounded SDK.

## 1. Establish the contract

Define the smallest public concepts for sources, evidence, retrieval, citations, and adapter capabilities. The result must be explainable to consumers outside DevCodex.

## 2. Prove one end-to-end path

Implement one supported ingestion-to-citation workflow with tests for source changes and observable failure behavior. This is the point at which an installation guide becomes meaningful.

## 3. Publish the first SDK surface

Release `@devcodex/lorebit` only with an explicit version policy, a minimal runnable example, and documentation that distinguishes stable features from experiments.

## 4. Expand adapters deliberately

Add providers when they satisfy demonstrated workflow needs. Each adapter should make its capabilities, operational limits, and recovery behavior clear; provider count is not the success metric.

## What stays out of scope

Building a generic vector database is not the roadmap. lorebit should remain a portable knowledge-workflow module whose consumers can adapt storage to their own environments.

Return to [the adoption plan](/en/start/first-plan).
