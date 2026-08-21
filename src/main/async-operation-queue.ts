export class AsyncOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.tail.then(operation, operation);
    this.tail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }
}
