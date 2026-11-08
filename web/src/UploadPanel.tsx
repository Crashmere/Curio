import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, CheckCheck, CircleAlert, FileImage, FolderOpen, Pause, Play, RotateCw, Upload, X } from "lucide-react";
import { api, bytes, Scope, scoped, UploadSession } from "./api";
import { Dialog } from "./components";
import * as importer from "./upload";

export function UploadPanel({ scope, targetLabel, close, pick, folder }: { scope: Scope; targetLabel?: string; close: () => void; pick: () => void; folder: () => void }) {
  const transfer = useSyncExternalStore(importer.subscribe, importer.snapshot);
  const items = transfer.items.filter(item => item.scope === scope);
  const completed = items.filter(item => item.state === "done" || item.state === "duplicate").length;
  const busy = items.some(item => ["reading", "uploading", "verifying"].includes(item.state));
  const [sessions, setSessions] = useState<UploadSession[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<{ items: UploadSession[] }>(scoped("uploads", scope), undefined, undefined, controller.signal).then(result => setSessions(result.items || [])).catch(error => { if (!controller.signal.aborted) setError(String(error.message || error)); });
    return () => controller.abort();
  }, [scope, transfer.running, transfer.paused]);
  const pending = sessions.filter(session => !items.some(item => item.hash === session.id));
  return <Dialog title="收集素材" close={close} wide>
    <div className="import-target"><span className={`mode-dot ${scope === "hidden" ? "hidden" : ""}`} />{scope === "hidden" ? "上传到隐藏模式" : "上传到普通模式"}</div>
    {targetLabel && <p className="form-help">{targetLabel}</p>}
    <div className="upload-drop-zone" onClick={pick}><Upload size={32} strokeWidth={1.5} /><strong>拖入图片、动图或视频</strong><span>也可以点击选择文件，或粘贴图片</span><div className="upload-choices"><button className="button primary" onClick={event => { event.stopPropagation(); pick(); }}><FileImage size={16} />选择文件</button><button className="button" onClick={event => { event.stopPropagation(); folder(); }}><FolderOpen size={16} />选择文件夹</button></div></div>
    <div className="transfer-info"><span>原件完整保留 · 分段上传</span><span>中断后重新选择原文件即可续传</span></div>
    {error && <div className="inline-error">{error}</div>}
    {!!items.length && <><div className="section-toolbar"><span>本次收集 <strong>{completed}</strong> / {items.length}</span><div>{(busy || transfer.paused || items.some(item => item.state === "waiting" || item.state === "error")) && <button className="button subtle" onClick={transfer.paused || !transfer.running ? importer.resume : importer.pause}>{transfer.paused || !transfer.running ? <Play size={15} /> : <Pause size={15} />}{transfer.paused || !transfer.running ? "继续 / 重试" : "暂停"}</button>}<button className="button subtle" onClick={importer.clearFinished}>清除已完成</button></div></div>
      <div className="upload-list">{items.map(item => <div className={`upload-row ${item.state}`} key={item.id}>
        <div className="upload-state-icon">{item.state === "done" ? <Check size={18} /> : item.state === "duplicate" ? <CheckCheck size={18} /> : item.state === "error" ? <CircleAlert size={18} /> : item.state === "waiting" ? <Pause size={17} /> : <RotateCw size={17} className="spin" />}</div>
        <div className="upload-description"><strong title={item.name}>{item.name}</strong><div className="upload-meta"><span>{bytes(item.file.size)}</span><span>{({ waiting: transfer.paused ? "已暂停" : "等待上传", reading: "读取与校验", uploading: "上传中", verifying: "完整校验", done: "原件已保存", duplicate: "相同原件已存在", error: "上传失败" })[item.state]}</span></div>{!["done", "duplicate", "error"].includes(item.state) && <div className="progress-track"><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></div>}{item.error && <p className="upload-error">{item.error}</p>}</div>
        <span className="upload-percent">{item.state === "error" ? <button className="icon-button" aria-label="重试上传" onClick={importer.resume}><RotateCw size={16} /></button> : `${Math.round(item.progress * 100)}%`}</span>
      </div>)}</div></>}
    {!!pending.length && <div className="unfinished"><h3>尚未完成的上传</h3><p>选择相同原文件继续，已经确认的分片不必重传。</p>{pending.map(session => <div className="unfinished-row" key={session.id}><span>{session.name}</span><small>{bytes(session.offset)} / {bytes(session.size)}</small></div>)}</div>}
    <footer className="dialog-footer"><button className="button" onClick={close}><X size={15} />关闭面板</button></footer>
  </Dialog>;
}
