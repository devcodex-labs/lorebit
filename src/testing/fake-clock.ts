import { decodeRfc3339Utc, type Rfc3339Utc } from '../wire/rfc3339.js';
import type { Clock } from '../ports/clock.js';

export class FakeClock implements Clock {
  #milliseconds: number;

  constructor(initial: Rfc3339Utc) {
    const decoded = decodeRfc3339Utc(initial);
    if (!decoded.ok) {
      throw new TypeError(decoded.error.summary);
    }
    this.#milliseconds = Date.parse(initial);
  }

  now(): Rfc3339Utc {
    return new Date(this.#milliseconds).toISOString() as Rfc3339Utc;
  }

  advanceMilliseconds(milliseconds: number): Rfc3339Utc {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError('FakeClock increments must be non-negative safe integers.');
    }
    this.#milliseconds += milliseconds;
    return this.now();
  }

  set(instant: Rfc3339Utc): void {
    const decoded = decodeRfc3339Utc(instant);
    if (!decoded.ok) {
      throw new TypeError(decoded.error.summary);
    }
    this.#milliseconds = Date.parse(instant);
  }
}
