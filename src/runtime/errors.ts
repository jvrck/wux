export class WuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WuxError";
  }
}
