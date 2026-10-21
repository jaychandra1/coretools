import type { Attachment } from "svelte/attachments";

/**
 * Drag-to-reorder for one list of keyed items (HTML5 drag and drop), shared
 * by the space tabs, the credential rows and the Authenticator cards. Each
 * list has its own instance, so dragging in one never drops into another.
 * Dragging is a mouse shortcut: every list also offers keyboard moves.
 *
 *   const sort = new Sortable<string>((dragged, target) => save(...));
 *   <div {@attach sort.item(id, movable)} class:drop-target={sort.over === id}>
 */
export class Sortable<K> {
  /** The item being dragged, and the one it would land on. */
  dragged = $state<K | null>(null);
  over = $state<K | null>(null);

  readonly #ondrop: (dragged: K, target: K) => void;

  constructor(ondrop: (dragged: K, target: K) => void) {
    this.#ondrop = ondrop;
  }

  /**
   * Wire one item. `draggable`: it can be picked up; `droppable`: others can
   * land on it (the All tab is neither — it stays first).
   */
  item(key: K, draggable = true, droppable = draggable): Attachment<HTMLElement> {
    return (node) => {
      node.draggable = draggable;
      const accepts = () => droppable && this.dragged !== null && this.dragged !== key;

      const start = (event: DragEvent) => {
        if (!draggable) return;
        this.dragged = key;
        if (event.dataTransfer) {
          // Some engines refuse to start a drag without data.
          event.dataTransfer.setData("text/plain", String(key));
          event.dataTransfer.effectAllowed = "move";
        }
      };
      const over = (event: DragEvent) => {
        if (!accepts()) return;
        event.preventDefault(); // required for the drop event to fire
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        this.over = key;
      };
      const leave = () => {
        if (this.over === key) this.over = null;
      };
      const drop = (event: DragEvent) => {
        event.preventDefault();
        const dragged = this.dragged;
        const ok = accepts();
        this.end();
        if (ok && dragged !== null) this.#ondrop(dragged, key);
      };
      const end = () => this.end();

      node.addEventListener("dragstart", start);
      node.addEventListener("dragover", over);
      node.addEventListener("dragleave", leave);
      node.addEventListener("drop", drop);
      node.addEventListener("dragend", end);
      return () => {
        node.removeEventListener("dragstart", start);
        node.removeEventListener("dragover", over);
        node.removeEventListener("dragleave", leave);
        node.removeEventListener("drop", drop);
        node.removeEventListener("dragend", end);
      };
    };
  }

  /** Forget a drag in progress (it ended, or the list stopped being sortable). */
  end(): void {
    this.dragged = null;
    this.over = null;
  }
}
