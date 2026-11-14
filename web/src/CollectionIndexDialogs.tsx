import { useState } from "react";
import { Check, RotateCw, Trash2 } from "lucide-react";
import { CollectionIndexGroup, Entity } from "./api";
import { Dialog } from "./components";

export function CollectionIndexGroupEditor({ group, collection, groups, close, save }: {
  group?: CollectionIndexGroup; collection?: Entity; groups: CollectionIndexGroup[];
  close: () => void; save: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(group?.name || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = name !== (group?.name || "");
  async function submit() {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) { setError("请输入分组名称"); return; }
    if (trimmed === "未分组") { setError("请使用其他名称，“未分组”用于尚未归类的收藏集"); return; }
    if (groups.some(item => item.id !== group?.id && item.name === trimmed)) { setError("已存在同名分组"); return; }
    setBusy(true); setError("");
    try { await save(trimmed); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title={group ? "重命名收藏集分组" : "新建收藏集分组"} close={close} dirty={dirty} busy={busy}>
    <form className="metadata-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>分组名称<input value={name} maxLength={80} autoFocus disabled={busy} placeholder="例如：游戏世界、设计参考" onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)} /></label>
      {collection && <p className="form-help">创建后，“{collection.name}”会移入这个分组。</p>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <footer className="dialog-footer"><button className="button" type="button" data-dialog-close disabled={busy}>取消</button><button className="button primary" type="submit" disabled={!name.trim() || busy || (!!group && !dirty)}>{busy ? <RotateCw size={15} className="spin" /> : <Check size={15} />}{group ? "保存" : "创建分组"}</button></footer>
    </form>
  </Dialog>;
}

export function RemoveCollectionIndexGroup({ group, close, confirm }: {
  group: CollectionIndexGroup; close: () => void; confirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog title="删除收藏集分组" close={close} busy={busy}>
    <div className="confirm-content"><p>删除“{group.name}”？分组内的收藏集会移至“未分组”，收藏集和素材全部保留。</p>{error && <div className="inline-error" role="alert">{error}</div>}</div>
    <footer className="dialog-footer"><button className="button" data-dialog-close disabled={busy}>取消</button><button className="button danger" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await confirm(); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    }}>{busy ? <RotateCw size={15} className="spin" /> : <Trash2 size={15} />}删除分组</button></footer>
  </Dialog>;
}
