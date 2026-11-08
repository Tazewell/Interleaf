import type { Annotation, ReaderAnnotationTarget } from "@interleaf/core";

// Observe the text layer without intercepting text selection or PDF links.
export class PDFAnnotationLayer {
  private pages = new Map<
    number,
    { annotations: Annotation[]; signature: string }
  >();
  private painted = new Map<
    number,
    {
      page: HTMLElement;
      signature: string;
      groups: HTMLElement[];
    }
  >();
  private pressed?: { x: number; y: number };
  constructor(
    private host: HTMLElement,
    private activate: (target: ReaderAnnotationTarget) => void,
  ) {
    host.addEventListener("pointermove", this.move);
    host.addEventListener("pointerleave", this.clear);
    host.addEventListener("pointerdown", this.press);
    host.addEventListener("click", this.click, true);
    host.addEventListener("scroll", this.clear, { passive: true });
  }
  setAnnotations(annotations: Annotation[]) {
    const previous = this.pages;
    const pages: typeof this.pages = new Map();
    for (const annotation of annotations) {
      if (annotation.location.type !== "pdf" || annotation.kind === "bookmark")
        continue;
      const pageNumber = annotation.location.page;
      let page = pages.get(pageNumber);
      if (!page)
        pages.set(pageNumber, (page = { annotations: [], signature: "" }));
      page.annotations.push(annotation);
    }
    for (const page of pages.values()) {
      page.signature = JSON.stringify(
        page.annotations.map((annotation) => [
          annotation.id,
          annotation.kind,
          annotation.color || "#facc15",
          annotation.location.type === "pdf"
            ? (annotation.location.rects || []).map((rect) => [
                rect.x,
                rect.y,
                rect.width,
                rect.height,
              ])
            : [],
        ]),
      );
    }
    this.pages = pages;
    for (const pageNumber of new Set([...previous.keys(), ...pages.keys()])) {
      const signature = pages.get(pageNumber)?.signature || "";
      if (
        previous.get(pageNumber)?.signature !==
          pages.get(pageNumber)?.signature ||
        !this.current(pageNumber, signature)
      )
        this.paint(pageNumber);
    }
  }
  private current(pageNumber: number, signature: string, page?: HTMLElement) {
    const painted = this.painted.get(pageNumber);
    return (
      !!painted &&
      painted.signature === signature &&
      (!page || painted.page === page) &&
      this.host.contains(painted.page) &&
      painted.groups.every((group) => group.parentElement === painted.page)
    );
  }
  paint = (pageNumber?: number) => {
    if (pageNumber === undefined) {
      for (const number of new Set([
        ...this.pages.keys(),
        ...this.painted.keys(),
      ]))
        this.paint(number);
      return;
    }
    const page = this.host.querySelector<HTMLElement>(
      `.page[data-page-number="${pageNumber}"]`,
    );
    if (!page) {
      this.painted.delete(pageNumber);
      return;
    }
    const data = this.pages.get(pageNumber);
    const signature = data?.signature || "";
    if (this.current(pageNumber, signature, page)) return;
    // Rendering can refresh annotations between pointerdown and click. Keep the
    // gesture alive; removing the old markers also removes their hover state.
    this.painted.get(pageNumber)?.groups.forEach((group) => group.remove());
    page.querySelectorAll(".interleaf-annotation").forEach((el) => el.remove());
    const groups: HTMLElement[] = [];
    for (const annotation of data?.annotations || []) {
      if (annotation.location.type !== "pdf") continue;
      // Composite the entire annotation once. Range.getClientRects() may
      // include overlapping element/text boxes, which must not darken the mark.
      const group = document.createElement("div");
      group.className = "interleaf-annotation";
      group.style.setProperty(
        "--annotation-color",
        annotation.color || "#facc15",
      );
      for (const rect of annotation.location.rects || []) {
        const el = document.createElement("div");
        el.className = "interleaf-highlight";
        el.dataset.annotationId = annotation.id;
        el.dataset.kind = annotation.kind;
        Object.assign(el.style, {
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
        });
        group.append(el);
      }
      if (group.childElementCount) {
        page.append(group);
        groups.push(group);
      }
    }
    this.painted.set(pageNumber, { page, signature, groups });
  };
  clear = () => {
    this.pressed = undefined;
    this.host
      .querySelectorAll(".interleaf-highlight[data-hovered]")
      .forEach((el) => el.removeAttribute("data-hovered"));
  };
  private find(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, input, textarea, [data-block-action]"))
      return;
    const page = target?.closest<HTMLElement>(".page[data-page-number]");
    if (!page || !this.host.contains(page)) return;
    const bounds = page.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    const ids: string[] = [];
    let hit;
    for (const annotation of this.pages.get(Number(page.dataset.pageNumber))
      ?.annotations || []) {
      if (
        annotation.kind === "bookmark" ||
        annotation.location.type !== "pdf" ||
        annotation.location.page !== Number(page.dataset.pageNumber)
      )
        continue;
      const rect = annotation.location.rects?.find(
        (r) =>
          x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height,
      );
      if (rect) {
        ids.push(annotation.id);
        hit = rect;
      }
    }
    if (!hit) return;
    return {
      ids,
      anchor: {
        x: event.clientX,
        top: bounds.top + hit.y * bounds.height,
        bottom: bounds.top + (hit.y + hit.height) * bounds.height,
      },
    };
  }
  private move = (event: PointerEvent) => {
    const hit =
      !event.buttons && !window.getSelection()?.toString().trim()
        ? this.find(event)
        : undefined;
    this.host
      .querySelectorAll<HTMLElement>(".interleaf-highlight")
      .forEach((el) =>
        el.toggleAttribute(
          "data-hovered",
          !!hit?.ids.includes(el.dataset.annotationId!),
        ),
      );
  };
  private press = (event: PointerEvent) => {
    this.clear();
    if (event.button === 0 && this.find(event))
      this.pressed = { x: event.clientX, y: event.clientY };
  };
  private click = (event: MouseEvent) => {
    const pressed = this.pressed;
    this.pressed = undefined;
    if (
      !pressed ||
      event.button !== 0 ||
      Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5 ||
      window.getSelection()?.toString().trim()
    )
      return;
    const hit = this.find(event);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    this.activate(hit);
  };
  destroy() {
    this.clear();
    this.host.removeEventListener("pointermove", this.move);
    this.host.removeEventListener("pointerleave", this.clear);
    this.host.removeEventListener("pointerdown", this.press);
    this.host.removeEventListener("click", this.click, true);
    this.host.removeEventListener("scroll", this.clear);
    this.host
      .querySelectorAll(".interleaf-annotation")
      .forEach((el) => el.remove());
    this.pages.clear();
    this.painted.clear();
  }
}
