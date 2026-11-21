import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, RotateCw, Trash2 } from "lucide-react";
import { api, bytes, type Asset, type Entity, type Scope, scoped } from "./api";
import { Dialog, Empty, kindNames } from "./components";
import { useIsPresent } from "./motion";
import type { SimilarityAsset, SimilarityMessage, SimilarityPair, SimilarityProgress, SimilarityResult } from "./collection-similarity";
import "./collection-similarity.css";

const pageSize = 20;

export function CollectionSimilarity({ collection, scope, close, changed }: { collection: Entity; scope: Scope; close: () => void; changed: () => void }) {
  const present = useIsPresent();
  const worker = useRef<Worker | null>(null);
  const mounted = useRef(false);
  const saving = useRef(false);
  const [result, setResult] = useState<SimilarityResult>();
  const [progress, setProgress] = useState<SimilarityProgress>({ stage: "loading", completed: 0, total: 0 });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<{ pair: SimilarityPair; keep: SimilarityAsset; discard: SimilarityAsset }>();
  const [page, setPage] = useState(0);
  const [removed, setRemoved] = useState(0);
  const [notice, setNotice] = useState("");

  useLayoutEffect(() => {
    mounted.current = present;
    if (!present) {
      worker.current?.terminate(); worker.current = null;
      setResult(undefined); setChoice(undefined); setError(""); setNotice("");
      setProgress({ stage: "loading", completed: 0, total: 0 }); setPage(0); setRemoved(0);
    }
    return () => { mounted.current = false; worker.current?.terminate(); worker.current = null; };
  }, [present]);
  useEffect(() => {
    if (!present) return;
    // Defer startup so StrictMode's setup probe does not launch a second scan.
    const timer = window.setTimeout(() => {
      try {
        const task = new Worker(new URL("./collection-similarity.worker.ts", import.meta.url), { type: "module" });
        worker.current = task;
        task.onmessage = (event: MessageEvent<SimilarityMessage>) => {
          if (!mounted.current || worker.current !== task) return;
          const message = event.data;
          if (message.type === "progress") setProgress(message.progress);
          else {
            if (message.type === "done") setResult(message.result);
            else setError(message.error);
            task.terminate(); worker.current = null;
          }
        };
        task.onerror = () => {
          if (!mounted.current || worker.current !== task) return;
          setError("相似项计算失败，请关闭后重试"); task.terminate(); worker.current = null;
        };
        task.postMessage({ collectionId: collection.id, scope });
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    }, 0);
    return () => { clearTimeout(timer); worker.current?.terminate(); worker.current = null; };
  }, [collection.id, scope, present]);

  async function confirmChoice() {
    if (!choice || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    const { keep, discard } = choice;
    try {
      const current = await Promise.all([keep, discard].map(asset => api<Asset>(scoped(`assets/${asset.id}`, scope), undefined, undefined, AbortSignal.timeout(15000))));
      if (!mounted.current) return;
      if (current.some(asset => asset.trashedAt || !asset.collections.some(item => item.id === collection.id))) throw new Error("这对素材已被移出收藏集或移入回收站，请关闭后重新计算");
      await api(scoped(`assets/${discard.id}`, scope), { trash: true }, "PATCH");
      changed();
      if (!mounted.current) return;
      setResult(previous => {
        if (!previous) return previous;
        const assets = { ...previous.assets }; delete assets[discard.id];
        return { ...previous, assets, pairs: previous.pairs.filter(pair => pair.left !== discard.id && pair.right !== discard.id) };
      });
      setChoice(undefined); setRemoved(value => value + 1);
      setNotice(`已保留“${keep.title || keep.name}”，将“${discard.title || discard.name}”移入回收站`);
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const pages = Math.max(1, Math.ceil((result?.pairs.length ?? 0) / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const stageNames = { loading: "读取收藏集", hashing: "计算像素指纹", comparing: "对比相似项" };
  return <Dialog title="收藏集相似项" wide close={close} busy={busy}>
    <div className="collection-similarity">
      <div className="similarity-intro"><strong>{collection.name} · {scope === "hidden" ? "隐藏模式" : "普通模式"}</strong><p>扫描整个收藏集，不受搜索、筛选、分页或折叠分组影响。关闭弹窗即清除计算数据，再次打开会重新计算。</p><p>按缩略图的 dHash 判定，差异不超过 4 / 64 位且宽高比接近。百分比是指纹相似度，不是原图像素一致率。动图和视频仅比较当前缩略画面，不比较完整动画或音轨。</p></div>
      {!result && !error && <div className="similarity-progress" role="status"><RotateCw size={20} className="spin" /><strong>{stageNames[progress.stage]}</strong><span>{progress.completed.toLocaleString()} / {progress.total ? progress.total.toLocaleString() : "…"}</span><progress max={Math.max(1, progress.total)} value={progress.completed} /></div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {result && <>
        <div className="similarity-summary"><strong>{result.pairs.length.toLocaleString()} 对待处理</strong><span>共 {result.total.toLocaleString()} 项 · 已计算 {result.checked.toLocaleString()} 项{removed > 0 ? ` · 已移入回收站 ${removed} 项` : ""}</span></div>
        {!!result.skipped.length && <details className="similarity-skipped"><summary>{result.skipped.length} 项未参与比较</summary><ul>{result.skipped.map((item, index) => <li key={index}><strong>{item.name}</strong>：{item.reason}</li>)}</ul></details>}
        {notice && <p className="similarity-notice" role="status"><Check size={15} />{notice}</p>}
        <p className="similarity-trash-note">选择保留项后，另一项将从所有收藏集中移入回收站，可在回收站恢复。不会永久删除原件。</p>
        {!result.pairs.length ? <Empty icon={<Copy size={28} />} title={removed ? "本次相似项已处理完" : "未找到高相似度的项"} description={result.skipped.length ? "未参与比较的项不代表没有相似项，可处理完成后重新打开计算。" : undefined} /> : <div className="similarity-pairs">
          {result.pairs.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(pair => {
            const left = result.assets[pair.left], right = result.assets[pair.right];
            const selecting = choice?.pair === pair;
            return <article className="similarity-pair" key={`${pair.left}:${pair.right}`}>
              <header><strong>dHash 相似度 {((1 - pair.distance / 64) * 100).toFixed(1)}%</strong><span>差异 {pair.distance} / 64 位</span></header>
              <div className="similarity-pair-items">{[left, right].map((asset, index) => <div className={`similarity-item ${selecting && choice.keep.id === asset.id ? "is-kept" : ""}`} key={asset.id}>
                <div className="similarity-thumbnail"><img src={asset.thumbnailUrl} alt={asset.title || asset.name} loading="lazy" /><span>{kindNames[asset.kind]}</span></div>
                <strong className="similarity-name" title={asset.title || asset.name}>{asset.title || asset.name}</strong>
                <span className="similarity-dimensions">{asset.width.toLocaleString()} × {asset.height.toLocaleString()} px</span>
                <small>{(asset.width * asset.height / 1e6).toFixed(2)} MP · {bytes(asset.size)}</small>
                <button className={`button ${selecting && choice.keep.id === asset.id ? "primary" : ""}`} disabled={busy} aria-pressed={selecting && choice.keep.id === asset.id} onClick={() => { setError(""); setChoice({ pair, keep: asset, discard: index === 0 ? right : left }); }}><Check size={15} />保留这项</button>
              </div>)}</div>
              {selecting && <div className="similarity-confirm"><p>将“{choice.discard.title || choice.discard.name}”移入回收站，保留另一项。</p><div><button className="button" disabled={busy} onClick={() => setChoice(undefined)}>取消</button><button className="button danger" disabled={busy} onClick={() => void confirmChoice()}>{busy ? <RotateCw size={15} className="spin" /> : <Trash2 size={15} />}确认移入回收站</button></div></div>}
            </article>;
          })}
        </div>}
        {pages > 1 && <nav className="similarity-pagination" aria-label="相似项分页"><button className="button" aria-label="上一页" disabled={!currentPage || busy} onClick={() => { setChoice(undefined); setPage(currentPage - 1); }}><ChevronLeft size={16} />上一页</button><span>{currentPage + 1} / {pages}</span><button className="button" aria-label="下一页" disabled={currentPage >= pages - 1 || busy} onClick={() => { setChoice(undefined); setPage(currentPage + 1); }}>下一页<ChevronRight size={16} /></button></nav>}
      </>}
    </div>
    <footer className="dialog-footer"><button className="button" disabled={busy} data-dialog-close>{!result && !error ? "取消计算并关闭" : "关闭并清除计算数据"}</button></footer>
  </Dialog>;
}
