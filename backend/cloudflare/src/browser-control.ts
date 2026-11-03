/** Exclusive browser input, including the gap while an LLM is thinking. */
export class BrowserControlInterrupted extends Error {
  constructor() { super("browser control changed"); }
}
export class BrowserControl {
  human = false;
  epoch = 0;
  owner: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  async acquire(owner: string) {
    if (this.owner && this.owner !== owner) throw new Error("This session is controlled on another connection.");
    // Stop admission immediately; acknowledgment waits for the in-flight action.
    this.owner = owner;
    this.human = true;
    this.epoch += 1;
    await this.serial(async () => {});
  }
  async release(owner: string) {
    await this.serial(async () => {
      if (!this.human || this.owner !== owner) throw new Error("Take control before continuing.");
      this.owner = null;
      this.human = false;
      this.epoch += 1;
    });
  }
  disconnect(owner: string) {
    if (this.owner === owner) { this.owner = null; this.epoch += 1; }
    // Human control stays paused on disconnect; never silently resume the agent.
  }
  agent<T>(epoch: number, operation: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      if (this.human || epoch !== this.epoch) throw new BrowserControlInterrupted();
      return operation();
    });
  }
  input<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      if (!this.human || this.owner !== owner) throw new Error("You do not control this session.");
      return operation();
    });
  }
}

export function validateBrowserInput(message: any) {
  const finite = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  switch (message?.type) {
    case "pointer":
      return ["move", "down", "up", "click"].includes(message.phase) && finite(message.x, 0, 1) && finite(message.y, 0, 1)
        && (!message.button || ["left", "right"].includes(message.button));
    case "scroll": return finite(message.dx, -3000, 3000) && finite(message.dy, -3000, 3000);
    case "text": return typeof message.text === "string" && message.text.length > 0 && message.text.length <= 4096;
    case "key": return ["Backspace", "Delete", "Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "a", "c", "v", "x", "z"].includes(message.key)
      && (message.modifiers == null || (Number.isInteger(message.modifiers) && message.modifiers >= 0 && message.modifiers <= 15));
    default: return false;
  }
}
