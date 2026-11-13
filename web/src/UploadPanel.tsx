import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, CheckCheck, CircleAlert, FileImage, FolderOpen, Pause, Play, RotateCw, Trash2, Upload, X } from "lucide-react";
import { api, bytes, Entity, Game, gameLabel, Scope, scoped, UploadSession } from "./api";
import { Dialog } from "./components";
import * as importer from "./upload";

type Destination = { tagIds?: string[]; collectionIds?: string[]; gameId?: string; screenshot?: boolean };
type DiscardTarget = { hash: string; name: string; size: number; offset?: number };
export type UploadPanelProps = {
  scope: Scope;
  targetLabel?: string;
  tags?: Entity[];
  collections?: Entity[];
  games?: Game[];
  close: () => void;
  pick: (session?: UploadSession) => void;
  folder: () => void;
  openAsset?: (id: string, existingHidden?: boolean, trashed?: boolean) => void;
};

export function UploadPanel({ scope, targetLabel, tags = [], collections = [], games = [], close, pick, folder, openAsset }: UploadPanelProps) {
  const transfer = useSyncExternalStore(importer.subscribe, importer.snapshot);
  const priority = (item: importer.UploadItem) => ["reading", "uploading", "verifying"].includes(item.state) ? 0 : ["done", "duplicate"].includes(item.state) ? 2 : 1;
  const items = transfer.items.filter(item => item.displayScope === scope).sort((a, b) => priority(a) - priority(b));
  const completed = items.filter(item => item.state === "done" || item.state === "duplicate").length;
  const active = transfer.items.some(item => ["waiting", "reading", "uploading", "verifying"].includes(item.state));
  const resumable = transfer.items.some(item => ["paused", "error"].includes(item.state));
  const [sessions, setSessions] = useState<UploadSession[]>([]);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [discard, setDiscard] = useState<DiscardTarget | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);
  const discardBox = useRef<HTMLDivElement>(null);
  useEffect(() => { if (discard) discardBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [discard]);
  const hasCleanup = sessions.some(session => session.state === "discarding");
  const reload = () => setRefresh(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const result = await api<{ items: UploadSession[] }>(scoped("uploads", scope), undefined, undefined, controller.signal);
        if (!controller.signal.aborted) { setSessions(result.items || []); setLoadError(""); }
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
      } finally { loading = false; }
    }
    void load();
    const timer = transfer.running || hasCleanup ? setInterval(() => void load(), 5000) : undefined;
    return () => { controller.abort(); clearInterval(timer); };
  }, [scope, transfer.running, transfer.paused, refresh, hasCleanup]);
  const pending = sessions.filter(session => !items.some(item => item.hash === session.id && !["done", "duplicate"].includes(item.state)));
  function destination(item: Destination) {
    const parts: string[] = [];
    const game = games.find(game => game.id === item.gameId);
    if (item.screenshot || item.gameId) parts.push(`游戏截图 · ${game ? gameLabel(game) : item.gameId ? "指定游戏" : "按文件名分组"}`);
    if (item.tagIds?.length) parts.push(`标签：${item.tagIds.map(id => tags.find(tag => tag.id === id)?.name || "已选标签").join("、")}`);
    if (item.collectionIds?.length) parts.push(`收藏集：${item.collectionIds.map(id => collections.find(collection => collection.id === id)?.name || "已选收藏集").join("、")}`);
    return parts.length ? parts.join(" · ") : "未整理素材";
  }
  function requestDiscard(target: DiscardTarget) {
    if (discardBusy) return;
    setError(""); setNotice(""); setDiscard(target);
  }
  async function discardUpload() {
    if (!discard || discardBusy) return;
    const target = discard;
    let accepted = false;
    setDiscardBusy(true); setError("");
    try {
      await importer.stopHash(target.hash);
      const result = await api<{ ok: boolean; pending?: boolean; error?: string }>(scoped(`uploads/${target.hash}`, scope), { confirm: true }, "DELETE");
      accepted = true;
      if (result.pending) {
        setSessions(previous => [...previous.filter(session => session.id !== target.hash), { id: target.hash, name: target.name, size: target.size, offset: target.offset || 0, chunkSize: 0, complete: false, state: "discarding" }]);
        setNotice(result.error || "已登记清理，后台将继续丢弃未完成的分片。");
      } else {
        setSessions(previous => previous.filter(session => session.id !== target.hash));
        setNotice("未完成的上传已丢弃，已保存的原件不受影响。");
      }
      setDiscard(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      importer.finishDiscard(target.hash, accepted);
      setDiscardBusy(false);
      reload();
    }
  }
  const labels: Record<importer.UploadItem["state"], string> = { waiting: "等待上传", paused: "已暂停", reading: "读取与校验", uploading: "上传中", verifying: "完整校验", done: "原件已保存", duplicate: "相同原件已存在", error: "上传失败" };
  return <Dialog title="收集素材" close={close} wide busy={discardBusy}>
    <div className="import-target"><span className={`mode-dot ${scope === "hidden" ? "hidden" : ""}`} />{scope === "hidden" ? "上传到隐藏模式" : "上传到普通模式"}</div>
    {targetLabel && <p className="form-help">新增文件：{targetLabel}</p>}
    <div className="upload-drop-zone" onClick={() => { if (!discardBusy) pick(); }}><Upload size={32} strokeWidth={1.5} /><strong>拖入图片、动图或视频</strong><span>也可以点击选择文件，或粘贴图片</span><div className="upload-choices"><button className="button primary" disabled={discardBusy} onClick={event => { event.stopPropagation(); pick(); }}><FileImage size={16} />选择文件</button><button className="button" disabled={discardBusy} onClick={event => { event.stopPropagation(); folder(); }}><FolderOpen size={16} />选择文件夹</button></div></div>
    <div className="transfer-info"><span>原件完整保留 · 分段上传</span><span>关闭时清除已完成记录，未完成上传继续保留</span></div>
    {loadError && <div className="inline-error">{loadError}<button className="button subtle" onClick={reload}>重新加载</button></div>}
    {notice && <p className="form-help upload-notice" role="status">{notice}</p>}
    {!!items.length && <><div className="section-toolbar"><span>本次收集 <strong>{completed}</strong> / {items.length}</span><div>{active && <button className="button subtle" disabled={discardBusy} title="暂停两种模式的全部上传" onClick={importer.pause}><Pause size={15} />暂停全部</button>}{(resumable || transfer.paused) && <button className="button subtle" disabled={discardBusy} title="继续两种模式的已暂停上传，并重试全部失败项" onClick={importer.resume}><Play size={15} />继续 / 重试全部</button>}<button className="button subtle" disabled={discardBusy || !completed} onClick={() => importer.clearFinished(scope)}>清除已完成</button></div></div>
      <div className="upload-list">{items.map(item => {
        const finished = item.state === "done" || item.state === "duplicate";
        const session = sessions.find(session => session.id === item.hash);
        const cleaning = session?.state === "discarding";
        return <div className={`upload-row ${item.state}`} key={item.id}>
          <div className="upload-state-icon">{item.state === "done" ? <Check size={18} /> : item.state === "duplicate" ? <CheckCheck size={18} /> : item.state === "error" ? <CircleAlert size={18} /> : ["waiting", "paused"].includes(item.state) ? <Pause size={17} /> : <RotateCw size={17} className="spin" />}</div>
          <div className="upload-description"><strong title={item.name}>{item.name}</strong><div className="upload-meta"><span>{bytes(item.file.size)}</span><span>{cleaning ? "分片清理中" : labels[item.state]}</span><span>{Math.round(item.progress * 100)}%</span></div><p className="upload-target-label">收集目标：{destination(item)}</p>{!finished && item.state !== "error" && <div className="progress-track"><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></div>}{item.error && <p className="upload-error">{item.error}</p>}{item.state === "duplicate" && <p className="upload-target-label">保留已有素材的信息{item.existingHidden !== undefined ? ` · ${item.existingHidden ? "位于隐藏模式" : "位于普通模式"}` : ""}{item.trashed ? " · 已在回收站，不会自动恢复" : ""}</p>}</div>
          <div className="upload-row-actions">
            {finished && item.assetId && openAsset && <button className="button subtle" disabled={discardBusy} onClick={() => openAsset(item.assetId!, item.existingHidden ?? item.displayScope === "hidden", item.trashed)}>{item.trashed ? "查看回收站素材" : item.state === "duplicate" ? "查看已有素材" : "查看素材"}</button>}
            {!finished && !cleaning && (["paused", "error"].includes(item.state) ? <button className="icon-button" aria-label={`${item.state === "error" ? "重试" : "继续"} ${item.name}`} title={item.state === "error" ? "仅重试此文件" : "仅继续此文件"} disabled={discardBusy} onClick={() => importer.resumeItem(item.id)}>{item.state === "error" ? <RotateCw size={16} /> : <Play size={16} />}</button> : <button className="icon-button" aria-label={`暂停 ${item.name}`} title="仅暂停此文件" disabled={discardBusy} onClick={() => importer.pauseItem(item.id)}><Pause size={16} /></button>)}
            {!finished && !cleaning && item.hash && (!item.expectedHash || item.hash === item.expectedHash) && <button className="icon-button danger" aria-label={`丢弃 ${item.name} 的未完成上传`} title="丢弃上传记录和已接收的分片" disabled={discardBusy} onClick={() => requestDiscard({ hash: item.hash!, name: item.name, size: item.file.size, offset: session?.offset })}><Trash2 size={15} /></button>}
            <button className="icon-button" aria-label={`移出列表 ${item.name}`} title={finished ? "移出本次列表，不删除已保存的原件" : "移出队列，保留服务器已接收的分片"} disabled={discardBusy || cleaning} onClick={() => { importer.removeItem(item.id); reload(); setNotice(finished ? "已移出本次列表，原件仍保留。" : "已移出队列，服务器已接收的分片仍可续传。"); }}><X size={15} /></button>
          </div>
        </div>;
      })}</div></>}
    {!!pending.length && <div className="unfinished"><h3>尚未完成的上传</h3><p>选择相同原文件继续，已经确认的分片不必重传。</p>{pending.map(session => <div className="unfinished-row" key={session.id}><div><span>{session.name}</span><small>{bytes(session.offset)} / {bytes(session.size)}{session.state === "discarding" ? " · 分片清理中" : ""}</small>{session.state !== "discarding" && <p className="upload-target-label">收集目标：{destination(session)}</p>}</div><div className="unfinished-actions">{session.state === "discarding" ? <span className="muted"><RotateCw size={14} className="spin" />后台继续清理</span> : <><button className="button subtle" disabled={discardBusy} onClick={() => pick(session)}>选择原文件继续</button><button className="icon-button danger" disabled={discardBusy} aria-label={`丢弃 ${session.name} 的未完成上传`} title="丢弃上传记录和已接收的分片" onClick={() => requestDiscard({ hash: session.id, name: session.name || "此文件", size: session.size, offset: session.offset })}><Trash2 size={15} /></button></>}</div></div>)}</div>}
    {discard && <div ref={discardBox} className="upload-discard confirm-content" role="alert"><h3>丢弃未完成的上传？</h3><p>“{discard.name}”{discard.offset !== undefined ? `已接收 ${bytes(discard.offset)}` : "的未完成分片"}将被清理。以后可重新选择原文件上传。</p><p className="muted">只删除此上传记录和未完成的分片，不删除已保存的原件、分类或回收站内容。</p>{error && <div className="inline-error">{error}</div>}<div className="dialog-footer"><button className="button" disabled={discardBusy} onClick={() => { setDiscard(null); setError(""); }}>保留上传</button><button className="button danger" disabled={discardBusy} onClick={() => void discardUpload()}>{discardBusy ? <RotateCw size={15} className="spin" /> : <Trash2 size={15} />}确认丢弃</button></div></div>}
    <footer className="dialog-footer"><button className="button" data-dialog-close disabled={discardBusy}><X size={15} />关闭面板</button></footer>
  </Dialog>;
}
