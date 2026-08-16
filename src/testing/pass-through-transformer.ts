import { diagnostic } from '../domain/diagnostics.js';
import type {
  ContentTransformer,
  TransformContentRequest,
  TransformContentResult
} from '../ports/content-transformer.js';

export class PassThroughTransformer implements ContentTransformer {
  readonly descriptor;
  readonly capabilities = Object.freeze({
    deterministic: true,
    maxExpansionRatio: 1,
    mediaTypes: ['text/plain'] as const
  });
  #closed = false;

  constructor(deploymentFingerprint = 'testing:pass-through:default') {
    this.descriptor = Object.freeze({
      kind: 'content-transformer' as const,
      adapterId: '@devcodex/lorebit/testing:pass-through-transformer',
      name: 'PassThroughTransformer',
      version: '0.1',
      deploymentFingerprint,
      testingOnly: true
    });
  }

  async transform(request: TransformContentRequest): Promise<TransformContentResult> {
    if (this.#closed) {
      return {
        ok: false,
        code: 'transform-failed',
        summary: 'Transformer is closed.',
        diagnostics: []
      };
    }
    if (request.options?.signal?.aborted === true) {
      return { ok: false, code: 'cancelled', summary: 'Transform was cancelled.', diagnostics: [] };
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(request.content);
    } catch {
      return {
        ok: false,
        code: 'content-quarantined',
        summary: 'Input is not valid UTF-8 text.',
        diagnostics: []
      };
    }
    if (text.length === 0) {
      return {
        ok: true,
        units: [],
        diagnostics: [
          diagnostic('empty-source-content', 'warning', 'The source produced no content units.')
        ]
      };
    }
    return {
      ok: true,
      units: [
        {
          stableKey: 'document',
          text,
          locator: {
            source: request.revision.locator,
            unitPath: 'document',
            start: 0,
            end: request.content.byteLength
          },
          metadata: request.revision.metadata,
          visibility: { labels: [...request.source.visibilityLabels] },
          disposition: 'available'
        }
      ],
      diagnostics: []
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
