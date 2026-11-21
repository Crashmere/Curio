import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Ban, Check, ChevronLeft, ChevronRight, Copy, RotateCw } from "lucide-react";
import { api, bytes, type Entity, type Scope, scoped } from "./api";
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
  const [excluded, setExcluded] = useState(0);
  const [notice, setNotice] = useState("");

  useLayoutEffect(() => {
    mounted.current = present;
    if (!present) {
      worker.current?.terminate(); worker.current = null;
      setResult(undefined); setChoice(undefined); setError(""); setNotice("");
      setProgress({ stage: "loading", completed: 0, total: 0 }); setPage(0); setRemoved(0); setExcluded(0);
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
      await api(scoped(`collections/${collection.id}/similarity/resolve`, scope), { keepId: keep.id, discardId: discard.id });
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

  function excludePair(pair: SimilarityPair) {
    if (saving.current) return;
    setResult(previous => previous && { ...previous, pairs: previous.pairs.filter(item => item !== pair) });
    setChoice(previous => previous?.pair === pair ? undefined : previous);
    setExcluded(value => value + 1);
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
        <div className="similarity-summary"><strong>{result.pairs.length.toLocaleString()} 对待处理</strong><span>共 {result.total.toLocaleString()} 项 · 已计算 {result.checked.toLocaleString()} 项{removed > 0 ? ` · 已移入回收站 ${removed} 项` : ""}{excluded > 0 ? ` · 本次已排除 ${excluded} 对` : ""}</span></div>
        {!!result.skipped.length && <details className="similarity-skipped"><summary>{result.skipped.length} 项未参与比较</summary><ul>{result.skipped.map((item, index) => <li key={index}><strong>{item.name}</strong>：{item.reason}</li>)}</ul></details>}
        {notice && <p className="similarity-notice" role="status"><Check size={15} />{notice}</p>}
        <p className="similarity-trash-note">点击“保留这项”后，再点击原地出现的“确认”，另一项才会移入回收站，可恢复。保留项未分组时，会继承另一项在当前收藏集中的分组。点击“排除”表示这两项不同，仅本次不再列出。</p>
        {!result.pairs.length ? !result.lowContrast.length && <Empty icon={<Copy size={28} />} title={removed || excluded ? "本次相似项已处理完" : "未找到高相似度的项"} description={result.skipped.length ? "未参与比较的项不代表没有相似项，可处理完成后重新打开计算。" : undefined} /> : <div className="similarity-pairs">
          {result.pairs.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(pair => {
            const left = result.assets[pair.left], right = result.assets[pair.right];
            const selecting = choice?.pair === pair;
            return <article className="similarity-pair" key={`${pair.left}:${pair.right}`}>
              <header><strong>dHash 相似度 {((1 - pair.distance / 64) * 100).toFixed(1)}%</strong><div className="similarity-pair-tools"><span>差异 {pair.distance} / 64 位</span><button className="button subtle similarity-exclude" disabled={busy} title="确认这两项不同，仅本次排除" onClick={() => excludePair(pair)}><Ban size={14} />排除</button></div></header>
              <div className="similarity-pair-items">{[left, right].map((asset, index) => {
                const armed = selecting && choice.keep.id === asset.id;
                const other = index === 0 ? right : left;
                return <SimilarityItem asset={asset} selected={armed} largerPixels={asset.width * asset.height > other.width * other.height} largerFile={asset.size > other.size} key={asset.id}>
                  <button className={`button ${armed ? "primary" : ""}`} disabled={busy} aria-pressed={armed} onClick={() => {
                    if (saving.current) return;
                    if (armed) void confirmChoice();
                    else { setError(""); setChoice({ pair, keep: asset, discard: index === 0 ? right : left }); }
                  }}>{busy && armed ? <RotateCw size={15} className="spin" /> : <Check size={15} />}{armed ? "确认" : "保留这项"}</button>
                </SimilarityItem>;
              })}</div>
            </article>;
          })}
        </div>}
        {pages > 1 && <nav className="similarity-pagination" aria-label="相似项分页"><button className="button" aria-label="上一页" disabled={!currentPage || busy} onClick={() => { setChoice(undefined); setPage(currentPage - 1); }}><ChevronLeft size={16} />上一页</button><span>{currentPage + 1} / {pages}</span><button className="button" aria-label="下一页" disabled={currentPage >= pages - 1 || busy} onClick={() => { setChoice(undefined); setPage(currentPage + 1); }}>下一页<ChevronRight size={16} /></button></nav>}
        {!!result.lowContrast.length && <section className="similarity-low-contrast" aria-label="低对比度素材"><h3>低对比度素材 <span>{result.lowContrast.length} 项</span></h3><p className="similarity-trash-note">以下素材直接列出供查看，未进行相似配对，不代表它们彼此相似。</p><div className="similarity-low-contrast-items">{result.lowContrast.map(id => <SimilarityItem asset={result.assets[id]} key={id} />)}</div></section>}
      </>}
    </div>
  </Dialog>;
}

function SimilarityItem({ asset, selected = false, largerPixels = false, largerFile = false, children }: { asset: SimilarityAsset; selected?: boolean; largerPixels?: boolean; largerFile?: boolean; children?: ReactNode }) {
  return <div className={`similarity-item ${selected ? "is-kept" : ""}`}>
    <div className="similarity-thumbnail"><img src={asset.thumbnailUrl} alt={asset.title || asset.name} loading="lazy" /><span>{kindNames[asset.kind]}</span></div>
    <strong className="similarity-name" title={asset.title || asset.name}>{asset.title || asset.name}</strong>
    <span className={`similarity-dimensions ${largerPixels ? "similarity-value-larger" : ""}`}>{asset.width.toLocaleString()} × {asset.height.toLocaleString()} px</span>
    <small><span className={largerPixels ? "similarity-value-larger" : undefined}>{(asset.width * asset.height / 1e6).toFixed(2)} MP</span> · <span className={largerFile ? "similarity-value-larger" : undefined}>{bytes(asset.size)}</span></small>
    {children}
  </div>;
}
