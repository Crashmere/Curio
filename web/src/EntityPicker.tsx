import { useEffect, useRef, useState } from "react";
import { Check, Plus, RotateCw, X } from "lucide-react";
import { api, CollectionGroupState, Entity, Scope, scoped } from "./api";
import { collectionSections } from "./collection-group-layout";

export type EntityPickerProps = {
  kind: "tags" | "collections";
  scope: Scope;
  items: Entity[];
  selected: string[];
  change: (ids: string[]) => void;
  disabled?: boolean;
  allowCreate?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onCreated?: (entity: Entity) => void;
  collectionLayout?: CollectionGroupState;
};

export function EntityPicker({ kind, scope, items, selected, change, disabled = false, allowCreate = true, onBusyChange, onCreated, collectionLayout }: EntityPickerProps) {
  const label = kind === "tags" ? "标签" : "收藏集";
  const [query, setQuery] = useState("");
  const [created, setCreated] = useState<Entity[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const choices = [...new Map([...created, ...items].map(item => [item.id, item])).values()];
  const search = query.trim().toLocaleLowerCase();
  const matches = choices.filter(item => item.name.toLocaleLowerCase().includes(search));
  const allSections = kind === "collections" && collectionLayout ? collectionSections(choices, collectionLayout, scope) : undefined;
  const grouped = allSections?.some(section => section.group);
  const sections = search ? allSections?.map(section => ({ ...section, items: section.items.filter(item => item.name.toLocaleLowerCase().includes(search)) })).filter(section => section.items.length) : allSections;
  const exact = search ? choices.find(item => item.name.toLocaleLowerCase() === search) : undefined;
  const unknown = selected.filter(id => !choices.some(item => item.id === id)).length;
  const working = busy || disabled;
  function toggle(id: string) {
    if (working) return;
    change(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]);
  }
  const choice = (item: Entity) => <button type="button" key={item.id} className={selected.includes(item.id) ? "selected" : ""} disabled={working} aria-pressed={selected.includes(item.id)} onClick={() => toggle(item.id)}>{selected.includes(item.id) && <Check size={12} />}{item.name}</button>;
  async function create() {
    if (working || controller.current || !query.trim()) return;
    if (exact) {
      if (!selected.includes(exact.id)) change([...selected, exact.id]);
      setQuery("");
      return;
    }
    if (!allowCreate) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true); onBusyChange?.(true); setError("");
    try {
      const result = await api<Entity>(scoped(kind, scope), { name: query.trim() }, undefined, request.signal);
      request.signal.throwIfAborted();
      const entity = { ...result, count: result.count || 0 };
      setCreated(previous => [...previous.filter(item => item.id !== entity.id), entity]);
      change(selected.includes(entity.id) ? selected : [...selected, entity.id]);
      setQuery("");
      onCreated?.(entity);
      if (!onCreated) window.dispatchEvent(new Event("curio-library-changed"));
    } catch (error) {
      if (!request.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    } finally {
      controller.current = null;
      if (!request.signal.aborted) { setBusy(false); onBusyChange?.(false); }
    }
  }
  return <div className="form-section entity-picker" role="group" aria-label={label}>
    <h3>{label}<span className="entity-picker-summary">已选 {selected.length} 个</span></h3>
    <div className="inline-create entity-picker-search"><input aria-label={`搜索${label}`} placeholder={allowCreate ? `搜索或新建${label}` : `搜索${label}`} value={query} disabled={working} maxLength={200} onChange={event => { setQuery(event.target.value); setError(""); }} onKeyDown={event => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (exact || allowCreate) void create();
      }
    }} />{query && <button type="button" className="icon-button" aria-label="清空搜索" disabled={working} onClick={() => setQuery("")}><X size={15} /></button>}{(allowCreate || exact) && <button type="button" className="button" disabled={working || !search || !!exact && selected.includes(exact.id)} onClick={() => void create()}>{busy ? <RotateCw size={14} className="spin" /> : exact ? <Check size={14} /> : <Plus size={14} />}{exact ? "选择已有" : "创建并选择"}</button>}</div>
    {sections ? <div className="entity-picker-sections">{sections.map(section => <section key={section.id} className="entity-picker-section" data-picker-group={section.id}>
      {grouped && <h4><span>{section.name}</span><span className="entity-picker-summary">{section.items.length}</span></h4>}
      <div className="choice-chips">{section.items.map(choice)}</div>
      {grouped && !section.items.length && <p className="muted">暂无收藏集</p>}
    </section>)}</div> : !!matches.length && <div className="choice-chips">{matches.map(choice)}</div>}
    {!matches.length && (!grouped || !sections?.length) && <p className="muted">{search ? `没有匹配的${label}${allowCreate ? "，可使用上方名称创建。" : "。"}` : `还没有${label}${allowCreate ? "，输入名称即可创建。" : "。"}`}</p>}
    {!!unknown && <p className="form-help">保留 {unknown} 个当前列表未显示的关联。</p>}
    {error && <div className="inline-error" role="alert">{error}</div>}
  </div>;
}
