import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  ContentUnitId,
  ContentUnitVersionId,
  RecipeId,
  RevisionId,
  SourceId,
  SpaceId
} from './ids.js';
import type { ImmutableContentRef, SourceLocator } from './source.js';

export interface ContentLocator {
  readonly source: SourceLocator;
  readonly unitPath: string;
  readonly start: number | null;
  readonly end: number | null;
}

export interface ContentUnitIdentity {
  readonly unitId: ContentUnitId;
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly stableKey: string;
}

export interface ContentUnitVersion {
  readonly schemaVersion: '1.0';
  readonly unitVersionId: ContentUnitVersionId;
  readonly spaceId: SpaceId;
  readonly identity: ContentUnitIdentity;
  readonly revisionId: RevisionId;
  readonly recipeId: RecipeId;
  readonly predecessorUnitVersionId: ContentUnitVersionId | null;
  readonly text: ImmutableContentRef;
  readonly textDigest: DigestRef;
  readonly locator: ContentLocator;
  readonly metadata: JsonValue;
  readonly metadataDigest: DigestRef;
  readonly visibility: JsonValue;
  readonly visibilityDigest: DigestRef;
  readonly disposition: 'available' | 'quarantined' | 'unknown';
  readonly createdAt: Rfc3339Utc;
}

export interface TransformedContentUnit {
  readonly stableKey: string;
  readonly text: string;
  readonly locator: ContentLocator;
  readonly metadata: JsonValue;
  readonly visibility: JsonValue;
  readonly disposition: 'available' | 'quarantined' | 'unknown';
}
