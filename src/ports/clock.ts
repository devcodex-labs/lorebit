import { formatRfc3339Utc, type Rfc3339Utc } from '../wire/rfc3339.js';

export interface Clock {
  now(): Rfc3339Utc;
}

export function createSystemClock(): Clock {
  return {
    now(): Rfc3339Utc {
      const formatted = formatRfc3339Utc(new Date());
      if (!formatted.ok) {
        throw new Error('System clock returned an invalid instant.');
      }
      return formatted.value;
    }
  };
}
