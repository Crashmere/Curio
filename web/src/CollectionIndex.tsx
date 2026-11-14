import { DragEvent, MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, ChevronRight, Folder, FolderInput, FolderPlus, GripVertical, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import { CollectionGroupState, CollectionIndexGroup, Entity, Scope } from "./api";
import { Empty } from "./components";
import { EntityCard } from "./EntityGrid";
import { collectionSections, createCollectionDragMotion, moveCollection, moveCollectionGroup } from "./collection-group-layout";
import "./collection-index.css";

type Dragged = { kind: "collection"; id: string; groupId: string } | { kind: "group"; id: string };
type DropCue = { kind: "collection"; groupId: string; id?: string; side?: "before" | "after" } | { kind: "group"; id: string; side: "before" | "after" };
type Menu = { kind: "collection" | "group"; id: string; left: number; top: number };
export type CollectionIndexProps = {
  items: Entity[]; scope: Scope; state: CollectionGroupState; searching: boolean; busy: boolean; query?: string;
  open: (entity: Entity) => void; edit: (entity: Entity) => void; rename: (entity: Entity) => void;
  pin: (entity: Entity) => void; remove: (entity: Entity) => void; create: (groupId?: string) => void;
  save: (next: CollectionGroupState) => Promise<void>;
  createGroup: (collection?: Entity) => void; renameGroup: (group: CollectionIndexGroup) => void; removeGroup: (group: CollectionIndexGroup) => void;
};

function readClosed(scope: Scope): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`curio:closed-collection-index-groups:${scope}`) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}

export function CollectionIndex({ items, scope, state, searching, busy, query, open, rename, pin, remove, create, save, createGroup, renameGroup, removeGroup }: CollectionIndexProps) {
  const root = useRef<HTMLDivElement>(null);
  const [motion] = useState(() => createCollectionDragMotion(() => root.current));
  const [closed, setClosed] = useState(() => ({ normal: readClosed("normal"), hidden: readClosed("hidden") }));
  const [drag, setDrag] = useState<Dragged>();
  const dragging = useRef<Dragged | undefined>(undefined);
  const [cue, setCue] = useState<DropCue>();
  const pendingLanding = useRef<{ before: CollectionGroupState; land: () => void } | undefined>(undefined);
  const [menu, setMenu] = useState<Menu>();
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuSource = useRef<HTMLButtonElement | null>(null);
  const moveButton = useRef<HTMLButtonElement>(null);
  const choiceRoot = useRef<HTMLDivElement>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [choicePosition, setChoicePosition] = useState({ left: 0, top: 0 });
  const allSections = collectionSections(items, state, scope);
  const needle = query?.trim().toLocaleLowerCase() ?? "";
  const sections = needle ? allSections.map(section => ({ ...section, items: section.items.filter(entity => entity.name.toLocaleLowerCase().includes(needle)) })).filter(section => section.items.length) : allSections;
  const namedSections = allSections.filter(section => section.group);
  const grouped = namedSections.length > 0;
  const shownCount = sections.reduce((count, section) => count + section.items.length, 0);
  const menuEntity = menu?.kind === "collection" ? items.find(entity => entity.id === menu.id) : undefined;
  const menuGroup = menu?.kind === "group" ? state.groups.find(group => group.id === menu.id) : undefined;
  const groupIndex = namedSections.findIndex(section => section.id === menuGroup?.id);
  const currentGroup = menuEntity ? state.groups.find(group => group.collectionIds.includes(menuEntity.id))?.id ?? "" : "";

  function closeMenu() { setMenu(undefined); setMoveOpen(false); }
  function resetDrag() {
    motion.clearPreview(); dragging.current = undefined; setDrag(undefined); setCue(undefined);
  }
  useEffect(() => () => motion.dispose(), [motion]);
  useEffect(() => { closeMenu(); resetDrag(); }, [scope]);
  useEffect(() => {
    if (busy || (menu && !menuEntity && !menuGroup) || (menuGroup && groupIndex < 0)) closeMenu();
    if (busy && dragging.current) resetDrag();
  }, [busy, menu, menuEntity, menuGroup, groupIndex]);
  useLayoutEffect(() => {
    const pending = pendingLanding.current;
    if (!pending || state === pending.before) return;
    pendingLanding.current = undefined;
    pending.land();
    root.current?.removeAttribute("data-settling");
  }, [state]);
  useLayoutEffect(() => {
    if (!menuRoot.current || !menuSource.current || !menu) return;
    const source = menuSource.current.getBoundingClientRect();
    const rect = menuRoot.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(source.right - rect.width, innerWidth - rect.width - 12));
    const below = source.bottom + 6;
    const top = below + rect.height <= innerHeight - 12 ? below : Math.max(12, source.top - rect.height - 6);
    if (left !== menu.left || top !== menu.top) setMenu({ ...menu, left, top });
  }, [menu, moveOpen, menuEntity, menuGroup]);
  useLayoutEffect(() => {
    if (!menu || !moveOpen || !menuRoot.current || !moveButton.current || !choiceRoot.current) return;
    const parent = menuRoot.current.getBoundingClientRect();
    const source = moveButton.current.getBoundingClientRect();
    const rect = choiceRoot.current.getBoundingClientRect();
    const right = parent.right + 6, leftward = parent.left - rect.width - 6;
    const left = Math.max(12, Math.min(right + rect.width <= innerWidth - 12 ? right : leftward, innerWidth - rect.width - 12));
    const top = Math.max(12, Math.min(source.top, innerHeight - rect.height - 12));
    setChoicePosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
  }, [menu, moveOpen, state, sections.length]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRoot.current?.contains(event.target) && !choiceRoot.current?.contains(event.target) && !menuSource.current?.contains(event.target)) closeMenu();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      event.preventDefault(); event.stopImmediatePropagation(); closeMenu();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && (menuRoot.current?.contains(event.target) || choiceRoot.current?.contains(event.target))) return;
      closeMenu();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", closeMenu);
    };
  }, [menu]);

  function toggleGroup(id: string) {
    const next = new Set(closed[scope]);
    if (next.has(id)) next.delete(id); else next.add(id);
    setClosed(previous => ({ ...previous, [scope]: next }));
    try { localStorage.setItem(`curio:closed-collection-index-groups:${scope}`, JSON.stringify([...next])); } catch { /* storage unavailable */ }
  }
  function showMenu(event: MouseEvent<HTMLButtonElement>, kind: Menu["kind"], id: string) {
    if (menu?.kind === kind && menu.id === id) { closeMenu(); return; }
    menuSource.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setMoveOpen(false); setMenu({ kind, id, left: rect.right, top: rect.bottom + 6 });
  }
  function commit(next: CollectionGroupState | undefined, kind: "collection" | "group", id: string) {
    if (!next || busy) { resetDrag(); return; }
    pendingLanding.current = { before: state, land: motion.capture(kind, id) };
    root.current?.setAttribute("data-settling", "");
    resetDrag();
    void save(next).catch(() => {
      pendingLanding.current = undefined;
      root.current?.removeAttribute("data-settling");
    });
  }
  function startCollectionDrag(event: DragEvent<HTMLElement>, id: string, groupId: string) {
    if (busy || (event.target instanceof Element && event.target.closest(".entity-actions"))) { event.preventDefault(); return; }
    resetDrag(); closeMenu(); motion.start(event);
    const value: Dragged = { kind: "collection", id, groupId };
    dragging.current = value; setDrag(value);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-curio-collection", id);
  }
  function startGroupDrag(event: DragEvent<HTMLElement>, id: string) {
    if (!id || busy || event.defaultPrevented) { event.preventDefault(); return; }
    resetDrag(); closeMenu(); motion.dispose();
    const value: Dragged = { kind: "group", id };
    dragging.current = value; setDrag(value);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-curio-collection-index-group", id);
  }
  function cardSide(event: DragEvent<HTMLElement>): "before" | "after" {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
  }
  function over(event: DragEvent<HTMLElement>, groupId: string, id?: string) {
    const value = dragging.current;
    if (!value || busy) return;
    if (value.kind === "group") {
      if (!groupId || groupId === value.id) { setCue(undefined); return; }
      event.preventDefault(); event.dataTransfer.dropEffect = "move";
      const rect = event.currentTarget.closest("[data-collection-group]")!.getBoundingClientRect();
      const side = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      setCue(previous => previous?.kind === "group" && previous.id === groupId && previous.side === side ? previous : { kind: "group", id: groupId, side });
      return;
    }
    event.preventDefault(); event.dataTransfer.dropEffect = "move";
    const side = id ? cardSide(event) : undefined;
    setCue(previous => previous?.kind === "collection" && previous.groupId === groupId && previous.id === id && previous.side === side ? previous : { kind: "collection", groupId, id, side });
  }
  function leave(event: DragEvent<HTMLElement>, id: string) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setCue(previous => (previous?.kind === "collection" && previous.groupId === id) || (previous?.kind === "group" && previous.id === id) ? undefined : previous);
  }
  function drop(event: DragEvent<HTMLElement>, groupId: string, id?: string) {
    event.preventDefault(); event.stopPropagation();
    const value = dragging.current;
    if (!value || busy) { resetDrag(); return; }
    if (value.kind === "group") {
      commit(cue?.kind === "group" && cue.id === groupId ? moveCollectionGroup(state, value.id, { id: groupId, side: cue.side }) : undefined, "group", value.id);
    } else commit(moveCollection(state, value.id, groupId, id ? { id, side: cardSide(event) } : undefined), "collection", value.id);
  }
  function moveThroughMenu(groupId: string) {
    const entity = menuEntity;
    closeMenu();
    if (entity && currentGroup !== groupId) commit(moveCollection(state, entity.id, groupId), "collection", entity.id);
  }
  function reorderGroup(direction: -1 | 1) {
    const group = menuGroup;
    const target = namedSections[groupIndex + direction];
    closeMenu();
    if (group && target) commit(moveCollectionGroup(state, group.id, { id: target.id, side: direction < 0 ? "before" : "after" }), "group", group.id);
  }

  return <div ref={root} className="collection-index" aria-busy={busy} onDragEnd={resetDrag}>
    <div className="collection-index-toolbar"><span>{busy ? "正在同步收藏集…" : "按主题整理收藏集"}</span><button className="button" disabled={busy} onClick={() => createGroup()}><FolderPlus size={15} />新建分组</button></div>
    {!shownCount && searching ? <Empty icon={<Search size={30} />} title="没有匹配的收藏集" description="试试其他关键词，或清空搜索。" /> : !items.length && !grouped ? <Empty icon={<Folder size={32} strokeWidth={1.3} />} title="还没有收藏集" description="把同一个游戏、角色或主题的素材放在一起。"><button className="button primary" disabled={busy} onClick={() => create()}><Plus size={15} />新建收藏集</button></Empty> :
      <div className="collection-index-groups">{sections.map(section => {
        const collapsed = grouped && closed[scope].has(section.id);
        const crossGroup = drag?.kind === "collection" && cue?.kind === "collection" && cue.groupId === section.id && drag.groupId !== section.id;
        const groupSide = cue?.kind === "group" && cue.id === section.id ? cue.side : undefined;
        return <section key={section.id} data-collection-group={section.id} className={`collection-index-group ${grouped ? "" : "flat"} ${crossGroup ? "drop-over" : ""} ${drag?.kind === "group" && drag.id === section.id ? "group-dragging" : ""} ${groupSide ? `group-drop-${groupSide}` : ""}`} onDragOver={event => over(event, section.id)} onDragLeave={event => leave(event, section.id)} onDrop={event => drop(event, section.id)}>
          {grouped && <div className="collection-group-head" draggable={!!section.id && !busy} onDragStart={event => { event.stopPropagation(); startGroupDrag(event, section.id); }}>
            {section.id && <GripVertical className="collection-group-grip" size={14} aria-hidden="true" />}
            <button className="collection-group-toggle" disabled={busy} aria-expanded={!collapsed} onClick={() => toggleGroup(section.id)}><ChevronRight size={16} className={collapsed ? "" : "expanded"} /><span>{section.name}</span><span className="collection-group-count">{section.items.length}</span></button>
            {section.group && <button className="icon-button collection-group-menu-toggle" aria-label={`分组操作：${section.name}`} title="分组操作" aria-haspopup="menu" aria-expanded={menu?.kind === "group" && menu.id === section.id} disabled={busy} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => showMenu(event, "group", section.id)}><MoreHorizontal size={17} /></button>}
            {crossGroup && <span className="collection-group-drop-hint"><FolderInput size={14} />松开以移入此分组</span>}
          </div>}
          <div className={`collection-group-content ${collapsed ? "collapsed" : ""}`} inert={collapsed}>
            <div className="collection-group-clip"><div className="entity-grid collections">
              {section.items.map(entity => {
                const cardCue = cue?.kind === "collection" && cue.id === entity.id && drag?.kind === "collection" && drag.id !== entity.id ? cue.side : undefined;
                return <EntityCard key={entity.id} entity={entity} kind="collections" open={open} disabled={busy} data-collection-id={entity.id} className={`collection-index-card ${drag?.kind === "collection" && drag.id === entity.id ? "dragging" : ""} ${cardCue ? `drop-${cardCue}` : ""}`} draggable={!busy}
                  onDragStart={event => startCollectionDrag(event, entity.id, section.id)} onDragOver={event => { event.stopPropagation(); over(event, section.id, entity.id); }} onDrop={event => drop(event, section.id, entity.id)}
                  actions={<button className="icon-button collection-menu-toggle" aria-label={`收藏集操作：${entity.name}`} title="收藏集操作" aria-haspopup="menu" aria-expanded={menu?.kind === "collection" && menu.id === entity.id} disabled={busy} onClick={event => showMenu(event, "collection", entity.id)}><MoreHorizontal size={18} /></button>} />;
              })}
              {!section.id ? <button className="collection-index-add" disabled={busy} onClick={() => create()}><span><Plus size={28} strokeWidth={1.2} /></span><strong>新建收藏集</strong></button> : !section.items.length ? <p className="collection-group-empty">拖动收藏集到这里，或通过收藏集菜单移入</p> : null}
            </div></div>
          </div>
        </section>;
      })}</div>}
    {menu && (menuEntity || menuGroup) && createPortal(<div ref={menuRoot} className="compact-action-menu collection-action-menu collection-index-menu collection-index-action-menu" style={{ left: menu.left, top: menu.top }} role="menu" aria-label={menuEntity ? `收藏集操作：${menuEntity.name}` : `分组操作：${menuGroup!.name}`}>
      <div className="action-menu-heading" title={menuEntity?.name ?? menuGroup?.name}>{menuEntity?.name ?? menuGroup?.name}</div>
      {menuEntity ? <>
        <button className="action-menu-item" role="menuitem" disabled={busy} onMouseEnter={() => setMoveOpen(false)} onClick={() => { closeMenu(); rename(menuEntity); }}><Pencil size={15} />重命名</button>
        <button className="action-menu-item" role="menuitem" disabled={busy} onMouseEnter={() => setMoveOpen(false)} onClick={() => { closeMenu(); pin(menuEntity); }}>{menuEntity.pinned ? <PinOff size={15} /> : <Pin size={15} />}{menuEntity.pinned ? "取消固定" : "固定到侧栏"}</button>
        <button ref={moveButton} className={`action-menu-item ${moveOpen ? "is-open" : ""}`} role="menuitem" aria-haspopup="menu" aria-expanded={moveOpen} disabled={busy} onMouseEnter={() => setMoveOpen(true)} onClick={() => setMoveOpen(true)}><FolderInput size={15} />移动到<ChevronRight className="collection-menu-arrow" size={14} /></button>
        <div className="action-menu-divider" role="separator" />
        <button className="action-menu-item action-menu-danger" role="menuitem" disabled={busy} onMouseEnter={() => setMoveOpen(false)} onClick={() => { closeMenu(); remove(menuEntity); }}><Trash2 size={15} />删除收藏集</button>
      </> : <>
        <button className="action-menu-item" role="menuitem" disabled={busy} onClick={() => { closeMenu(); create(menuGroup!.id); }}><FolderPlus size={15} />新建收藏集</button>
        <div className="action-menu-divider" role="separator" />
        <button className="action-menu-item" role="menuitem" disabled={busy} onClick={() => { closeMenu(); renameGroup(menuGroup!); }}><Pencil size={15} />重命名分组</button>
        <button className="action-menu-item" role="menuitem" disabled={busy || groupIndex <= 0} onClick={() => reorderGroup(-1)}><ArrowUp size={15} />上移分组</button>
        <button className="action-menu-item" role="menuitem" disabled={busy || groupIndex < 0 || groupIndex === namedSections.length - 1} onClick={() => reorderGroup(1)}><ArrowDown size={15} />下移分组</button>
        <div className="action-menu-divider" role="separator" />
        <button className="action-menu-item action-menu-danger" role="menuitem" disabled={busy} onClick={() => { closeMenu(); removeGroup(menuGroup!); }}><Trash2 size={15} />删除分组</button>
      </>}
    </div>, document.body)}
    {menuEntity && moveOpen && createPortal(<div ref={choiceRoot} className="compact-action-menu collection-action-menu collection-group-choices collection-index-action-menu" style={choicePosition} role="menu" aria-label="移动到分组">
      {allSections.map(section => <button key={section.id} className="action-menu-item collection-group-choice" role="menuitemradio" aria-checked={currentGroup === section.id} disabled={busy} onClick={() => moveThroughMenu(section.id)}><span>{section.name}</span>{currentGroup === section.id && <Check size={15} />}</button>)}
      <div className="action-menu-divider" role="separator" />
      <button className="action-menu-item" role="menuitem" disabled={busy} onClick={() => { closeMenu(); createGroup(menuEntity); }}><FolderPlus size={15} />新建分组</button>
    </div>, document.body)}
  </div>;
}
