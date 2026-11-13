import { useState } from "react";
import { Check, Group, RotateCw } from "lucide-react";
import { MediaGroup } from "./api";
import { Dialog } from "./components";

export function GroupEditor({ group, count, close, save }: { group?: MediaGroup; count: number; close: () => void; save: (name: string) => Promise<void> }) {
  const [name, setName] = useState(group?.name || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = name !== (group?.name || "");
  async function submit() {
    if (busy) return;
    setBusy(true); setError("");
    try { await save(name.trim()); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title={group ? "编辑分组名称" : "组成一组"} close={close} dirty={dirty} busy={busy}>
    <form className="metadata-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {!group && <p className="group-editor-summary"><Group size={18} />将 {count} 个素材组成一组</p>}
      <label>分组名称（可选）<input value={name} disabled={busy} onChange={event => setName(event.target.value)} maxLength={80} placeholder="例如：角色设定、同一系列" /></label>
      <p className="form-help">留空也可以分组，之后可随时添加或修改名称。</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <footer className="dialog-footer"><button type="button" className="button" data-dialog-close disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy || (!!group && !dirty)}>{busy ? <RotateCw size={15} className="spin" /> : <Check size={15} />}{group ? "保存" : "创建分组"}</button></footer>
    </form>
  </Dialog>;
}
