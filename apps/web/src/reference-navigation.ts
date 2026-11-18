import type { DocumentLocation, ReaderAdapter } from "@interleaf/core";

type NavigationReader = Pick<
  ReaderAdapter,
  "getLocation" | "goTo" | "isNear" | "focusReference" | "flashReference"
>;

// Keep the original reading position while visiting several references.
// A jump that stays on the same screen, or a reader who scrolls back, needs
// no return point.
export class ReferenceNavigation {
  origin?: DocumentLocation;
  busy = false;
  private departing = false;
  constructor(private reader?: NavigationReader) {}
  setReader(reader?: NavigationReader) {
    this.reader = reader;
  }
  async visit(target: DocumentLocation, text?: string) {
    if (this.busy || !this.reader) return;
    const origin = this.origin ?? structuredClone(this.reader.getLocation());
    this.busy = true;
    try {
      // A source citation may mount the original PDF while focus is pending.
      if (
        text === undefined ||
        !(await this.reader.focusReference?.(target, text))
      )
        await this.reader?.goTo(target);
      if (!this.reader) return;
      this.origin = origin;
      if (text !== undefined) this.reader.flashReference?.(target, text);
    } finally {
      this.busy = false;
    }
    this.settle();
  }
  /** Record where a jump started outside visit(), such as a PDF link. */
  remember(origin: DocumentLocation) {
    if (!this.busy && !this.origin) {
      this.origin = structuredClone(origin);
      this.departing = true;
    }
  }
  /** Forget the return point once it is on screen again; true if forgotten. */
  settle() {
    if (this.busy || !this.origin) return false;
    const near = this.reader?.isNear?.(this.origin);
    // PDF.js may emit pagechanging before its viewport has left the origin.
    if (this.departing) {
      if (!near) this.departing = false;
      return false;
    }
    if (!near) return false;
    this.origin = undefined;
    return true;
  }
  async back() {
    if (this.busy || !this.origin || !this.reader) return;
    this.busy = true;
    try {
      await this.reader.goTo(this.origin);
      this.origin = undefined;
      this.departing = false;
    } finally {
      this.busy = false;
    }
  }
}
