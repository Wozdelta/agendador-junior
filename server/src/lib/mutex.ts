/** Mutex simples baseado em promessas para serializar alterações. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Um mutex por chave (ex.: um por lote ou por tarefa). */
export class KeyedMutex {
  private map = new Map<string, Mutex>();
  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    let m = this.map.get(key);
    if (!m) {
      m = new Mutex();
      this.map.set(key, m);
    }
    return m.run(fn);
  }
}
