import { describe, expect, it, vi } from "vitest";
import { Sortable } from "./sortable.svelte";

/** Just enough of an element for the attachment: listeners and `draggable`. */
function fakeNode() {
  const listeners = new Map<string, (event: unknown) => void>();
  const node = {
    draggable: false,
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const fire = (type: string) => {
    const event = { preventDefault: vi.fn(), dataTransfer: { setData: vi.fn(), effectAllowed: "", dropEffect: "" } };
    listeners.get(type)?.(event);
    return event;
  };
  return { node: node as unknown as HTMLElement, listeners, fire };
}

describe("Sortable", () => {
  it("drops the dragged item onto the target", () => {
    const ondrop = vi.fn();
    const sort = new Sortable<string>(ondrop);
    const a = fakeNode();
    const b = fakeNode();
    sort.item("a")(a.node);
    sort.item("b")(b.node);
    expect(a.node.draggable).toBe(true);

    a.fire("dragstart");
    expect(sort.dragged).toBe("a");
    const over = b.fire("dragover");
    expect(over.preventDefault).toHaveBeenCalled(); // lets the drop happen
    expect(sort.over).toBe("b");
    b.fire("drop");
    expect(ondrop).toHaveBeenCalledWith("a", "b");
    expect(sort.dragged).toBeNull();
    expect(sort.over).toBeNull();
  });

  it("ignores drops onto itself and onto items that don't accept drops", () => {
    const ondrop = vi.fn();
    const sort = new Sortable<string>(ondrop);
    const a = fakeNode();
    const all = fakeNode();
    sort.item("a")(a.node);
    sort.item("", false)(all.node); // like the All tab: fixed in place
    expect(all.node.draggable).toBe(false);

    a.fire("dragstart");
    expect(a.fire("dragover").preventDefault).not.toHaveBeenCalled();
    expect(all.fire("dragover").preventDefault).not.toHaveBeenCalled();
    all.fire("drop");
    a.fire("drop");
    expect(ondrop).not.toHaveBeenCalled();
  });

  it("does nothing for drags that started elsewhere", () => {
    const ondrop = vi.fn();
    const sort = new Sortable<string>(ondrop);
    const b = fakeNode();
    sort.item("b")(b.node);
    expect(b.fire("dragover").preventDefault).not.toHaveBeenCalled();
    b.fire("drop");
    expect(ondrop).not.toHaveBeenCalled();
  });

  it("removes its listeners when detached", () => {
    const sort = new Sortable<string>(vi.fn());
    const a = fakeNode();
    const detach = sort.item("a")(a.node);
    expect(a.listeners.size).toBe(5);
    if (typeof detach === "function") detach();
    expect(a.listeners.size).toBe(0);
  });
});
