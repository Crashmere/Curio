import { DragEvent } from "react";
import { CollectionGroupState, CollectionIndexGroup, Entity, Scope } from "./api";

export type CollectionSection = { id: string; name: string; group?: CollectionIndexGroup; items: Entity[] };
export type CollectionDropTarget = { id: string; side: "before" | "after" };

export function collectionSections(items: Entity[], state: CollectionGroupState, scope: Scope): CollectionSection[] {
  const positions = new Map(state.collectionOrder.map((id, index) => [id, index]));
  const sorted = [...items].sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
  const assigned = new Set(state.groups.flatMap(group => group.collectionIds));
  return [
    ...state.groups.filter(group => group.scope === scope || sorted.some(item => group.collectionIds.includes(item.id)))
      .map(group => ({ id: group.id, name: group.name, group, items: sorted.filter(item => group.collectionIds.includes(item.id)) })),
    { id: "", name: "未分组", items: sorted.filter(item => !assigned.has(item.id)) }
  ];
}

export function moveCollection(state: CollectionGroupState, id: string, groupId: string, target?: CollectionDropTarget): CollectionGroupState | undefined {
  if (!state.collectionOrder.includes(id) || (groupId && !state.groups.some(group => group.id === groupId)) || target?.id === id) return;
  const destination = groupId ? new Set(state.groups.find(group => group.id === groupId)!.collectionIds) : new Set(state.collectionOrder.filter(value => !state.groups.some(group => group.collectionIds.includes(value))));
  if (target && !destination.has(target.id)) return;
  const current = state.groups.find(group => group.collectionIds.includes(id))?.id ?? "";
  const groups = state.groups.map(group => ({ ...group, collectionIds: [
    ...group.collectionIds.filter(value => value !== id), ...(group.id === groupId ? [id] : [])
  ] }));
  const collectionOrder = state.collectionOrder.filter(value => value !== id);
  // Keep unseen collections in the complete order; a group-area drop appends after its true last member.
  const anchor = target?.id ?? collectionOrder.filter(value => destination.has(value)).at(-1);
  const index = anchor === undefined ? state.collectionOrder.indexOf(id) : collectionOrder.indexOf(anchor) + (target?.side === "before" ? 0 : 1);
  collectionOrder.splice(index, 0, id);
  if (current === groupId && collectionOrder.every((value, i) => value === state.collectionOrder[i])) return;
  return { ...state, groups, collectionOrder };
}

export function moveCollectionGroup(state: CollectionGroupState, id: string, target: CollectionDropTarget): CollectionGroupState | undefined {
  const group = state.groups.find(value => value.id === id);
  if (!group || id === target.id) return;
  const groups = state.groups.filter(value => value.id !== id);
  const index = groups.findIndex(value => value.id === target.id);
  if (index < 0) return;
  groups.splice(index + (target.side === "after" ? 1 : 0), 0, group);
  if (groups.every((value, i) => value.id === state.groups[i]?.id)) return;
  return { ...state, groups };
}

export function createCollectionDragMotion(root: () => HTMLElement | null) {
  let preview: HTMLElement | null = null;
  const animations = new Set<Animation>();
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function elements(kind: "collection" | "group") {
    const found = new Map<string, HTMLElement>();
    const page = root();
    page?.querySelectorAll<HTMLElement>("[data-collection-group]").forEach(group => {
      const element = kind === "group" ? group : group.querySelector<HTMLElement>(".collection-group-head");
      if (element) found.set(`group:${group.dataset.collectionGroup}`, element);
      if (kind === "collection") {
        const empty = group.querySelector<HTMLElement>(".collection-group-empty");
        if (empty && !empty.closest(".collection-group-content.collapsed")) found.set(`empty:${group.dataset.collectionGroup}`, empty);
      }
    });
    if (kind === "collection") page?.querySelectorAll<HTMLElement>("[data-collection-id]").forEach(card => {
      if (!card.closest(".collection-group-content.collapsed")) found.set(`collection:${card.dataset.collectionId}`, card);
    });
    const add = kind === "collection" ? page?.querySelector<HTMLElement>(".collection-index-add") : undefined;
    if (add) found.set("add", add);
    return found;
  }
  function clearPreview() { preview?.remove(); preview = null; }
  function cancelAnimations() {
    for (const animation of animations) animation.cancel();
    animations.clear();
    root()?.removeAttribute("data-collection-motion");
  }
  function play(element: HTMLElement, frames: Keyframe[], duration: number) {
    const animation = element.animate(frames, { duration, easing: "cubic-bezier(.22, .8, .25, 1)" });
    animations.add(animation);
    const finish = () => {
      animations.delete(animation);
      if (!animations.size) root()?.removeAttribute("data-collection-motion");
    };
    void animation.finished.then(finish, finish);
  }
  function start(event: DragEvent<HTMLElement>) {
    clearPreview(); cancelAnimations();
    if (!event.dataTransfer) return;
    const card = event.currentTarget;
    const rect = card.getBoundingClientRect();
    const copy = card.cloneNode(true) as HTMLElement;
    copy.className = "entity-card collection-index-drag-preview collection-drag-preview";
    copy.removeAttribute("data-collection-id");
    copy.removeAttribute("draggable");
    copy.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
    copy.style.width = `${rect.width}px`;
    copy.style.height = `${rect.height}px`;
    preview = document.createElement("div");
    preview.className = "collection-index-drag-image";
    preview.setAttribute("aria-hidden", "true");
    preview.inert = true;
    preview.append(copy);
    document.body.append(preview);
    event.dataTransfer.setDragImage(preview, event.clientX - rect.left + 20, event.clientY - rect.top + 20);
  }
  function capture(kind: "collection" | "group", id: string) {
    const before = new Map([...elements(kind)].map(([key, element]) => [key, element.getBoundingClientRect()]));
    cancelAnimations();
    return () => {
      const page = root();
      if (!page || reduced()) return;
      const after = elements(kind);
      page.setAttribute("data-collection-motion", "");
      // Animate neighbors separately so the dropped collection never travels through its former group.
      for (const [key, element] of after) {
        if (key === `collection:${id}`) continue;
        const old = before.get(key);
        if (!old) {
          if (key.startsWith("empty:")) play(element, [{ opacity: 0 }, { opacity: 1 }], 140);
          continue;
        }
        const rect = element.getBoundingClientRect();
        const x = old.left - rect.left, y = old.top - rect.top;
        if (Math.abs(x) + Math.abs(y) > .5) play(element, [{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], 220);
      }
      if (kind === "collection") {
        const card = after.get(`collection:${id}`);
        if (card) play(card, [
          { transform: "scale(1.025)", filter: "drop-shadow(0 5px 10px #83603e26)" },
          { transform: "scale(.997)", offset: .72 },
          { transform: "none", filter: "none" }
        ], 260);
        else {
          const count = page.querySelector<HTMLElement>(`[data-collection-id="${CSS.escape(id)}"]`)?.closest("[data-collection-group]")?.querySelector<HTMLElement>(".collection-group-count");
          if (count) play(count, [{ transform: "scale(1.2)", color: "var(--accent)" }, { transform: "none", color: "var(--muted)" }], 220);
        }
      }
      if (!animations.size) page.removeAttribute("data-collection-motion");
    };
  }
  return { start, capture, clearPreview, dispose() { clearPreview(); cancelAnimations(); } };
}
