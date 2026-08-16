export class SeededRandom {
  #state: number;

  constructor(seed = 0x1a2b3c4d) {
    this.#state = seed >>> 0 || 1;
  }

  next(): number {
    let value = this.#state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.#state = value >>> 0;
    return this.#state / 0x1_0000_0000;
  }

  hex(bytes: number): string {
    let output = '';
    for (let index = 0; index < bytes; index += 1) output += Math.floor(this.next() * 256).toString(16).padStart(2, '0');
    return output;
  }
}
