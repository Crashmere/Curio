import { useState } from "react";
import { Check, Gamepad2, MoreHorizontal, Plus, RotateCw, Trash2 } from "lucide-react";
import { api, Asset, captureLabel, Game, gameLabel, Patch, Scope, scoped } from "./api";
import { Dialog, Empty } from "./components";

export function GamesGrid({ games, query, open, edit, remove, create }: { games: Game[]; query: string; open: (game: Game) => void; edit: (game: Game) => void; remove: (game: Game) => void; create: () => void }) {
  const search = query.trim().toLocaleLowerCase();
  const items = games.filter(game => `${game.name} ${game.steamAppId}`.toLocaleLowerCase().includes(search));
  if (!items.length) return <Empty icon={<Gamepad2 size={34} strokeWidth={1.3} />} title={search ? "没有匹配的游戏" : "收集你的游戏瞬间"} description={search ? "试试游戏名或 Steam App ID。" : "在这里上传图片或游戏录像，Steam 文件名自动按游戏 ID 分组，其他来源进入未指定游戏。"}><button className="button primary" onClick={create}><Plus size={15} />新建游戏</button></Empty>;
  return <div className="entity-grid games">{items.map(game => <article className="entity-card" key={game.id}><button className="entity-open" onClick={() => open(game)}><div className="entity-cover">{game.coverUrl ? <img src={game.coverUrl} alt="" loading="lazy" /> : <Gamepad2 size={36} strokeWidth={1.2} />}</div><div className="entity-card-info"><h2>{gameLabel(game)}</h2><span>{game.count} 个素材{game.steamAppId && ` · Steam ${game.steamAppId}`}</span>{game.lastCapturedAt && <time className="game-last-capture">{captureLabel(game.lastCapturedAt)}</time>}</div></button><div className="entity-actions"><button className="icon-button" aria-label={`命名 ${gameLabel(game)}`} title="编辑游戏名称" onClick={() => edit(game)}><MoreHorizontal size={17} /></button><button className="icon-button danger" aria-label={`删除游戏夹 ${gameLabel(game)}`} title="删除游戏夹" onClick={() => remove(game)}><Trash2 size={15} /></button></div></article>)}</div>;
}

export function RemoveGame({ game, close, confirm }: { game: Game; close: () => void; confirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (busy) return;
    setBusy(true); setError("");
    try { await confirm(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); }
  }
  return <Dialog title="删除游戏夹" close={close}><div className="confirm-content"><p>删除“{gameLabel(game)}”？截图和录像将保留在游戏截图中，并回到“未指定游戏”。</p><p className="muted">会解除该游戏的全部素材关联，包括隐藏及回收站中的素材。截图时间、原件、标签和收藏集均保留。</p>{game.steamAppId && <p className="muted">以后上传 Steam {game.steamAppId} 的新素材时，会再次自动创建游戏夹；重复导入已有素材不会重新归类。</p>}{error && <div className="inline-error">{error}</div>}</div><footer className="dialog-footer"><button className="button" onClick={close} disabled={busy}>取消</button><button className="button danger" disabled={busy} onClick={() => void remove()}>{busy ? <RotateCw size={15} className="spin" /> : <Trash2 size={15} />}确认删除</button></footer></Dialog>;
}

export function GameEditor({ game, scope, close, saved }: { game?: Game; scope: Scope; close: () => void; saved: () => void }) {
  const [name, setName] = useState(game?.name || "");
  const [appId, setAppId] = useState(game?.steamAppId || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (busy) return;
    setBusy(true); setError("");
    try { await api(scoped(game ? `games/${game.id}` : "games", scope), { name, steamAppId: appId }, game ? "PATCH" : "POST"); saved(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); }
  }
  return <Dialog title={game ? "编辑游戏名称" : "新建游戏"} close={close}><form className="metadata-form" onSubmit={event => { event.preventDefault(); void save(); }}><label>游戏名称<input value={name} onChange={event => setName(event.target.value)} maxLength={200} placeholder="例如：艾尔登法环" /></label><label>Steam App ID<input value={appId} onChange={event => setAppId(event.target.value)} readOnly={!!game} inputMode="numeric" placeholder="其他平台的游戏可留空" /></label><p className="form-help">{game?.steamAppId ? `名称会应用到 Steam ${game.steamAppId} 的全部截图，包括以后导入的截图。` : "Steam 截图自动匹配 App ID；其他来源可以手动加入这个游戏。"}</p>{error && <div className="inline-error">{error}</div>}<footer className="dialog-footer"><button type="button" className="button" onClick={close}>取消</button><button type="submit" className="button primary" disabled={busy || (!game && !name.trim() && !appId)}>{busy ? <RotateCw size={15} className="spin" /> : <Check size={15} />}保存</button></footer></form></Dialog>;
}

export function ScreenshotEditor({ asset, count, games, scope, close, save }: { asset?: Asset; count: number; games: Game[]; scope: Scope; close: () => void; save: (patch: Patch) => Promise<void> }) {
  const [enabled, setEnabled] = useState(true);
  const [gameId, setGameId] = useState(asset?.screenshot ? asset.game?.id || "" : "auto");
  const [capturedAt, setCapturedAt] = useState(asset?.capturedAt || "");
  const [newGame, setNewGame] = useState(false);
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [localGames, setLocalGames] = useState<Game[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices = [...games, ...localGames, ...(asset?.game && !games.some(game => game.id === asset.game!.id) ? [asset.game] : [])];
  async function create() {
    setBusy(true); setError("");
    try {
      const result = await api<{ id: string }>(scoped("games", scope), { name, steamAppId: appId });
      setLocalGames(previous => [...previous, { id: result.id, name: name.trim(), steamAppId: appId, count: 0 }]);
      setGameId(result.id); setNewGame(false); setName(""); setAppId("");
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (busy) return;
    setBusy(true); setError("");
    // Automatic classification preserves existing metadata and recognizes new members.
    const time = capturedAt.length === 16 ? `${capturedAt}:00` : capturedAt;
    const patch: Patch = enabled ? {
      screenshot: true,
      ...(gameId === "auto" ? {} : { gameId }),
      ...(asset && time !== asset.capturedAt ? { capturedAt: time } : {})
    } : { screenshot: false };
    try { await save(patch); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); }
  }
  return <Dialog title={asset ? "游戏截图信息" : `归类 ${count} 个游戏素材`} close={close}>
    <form className="metadata-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="form-switches"><label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />归入游戏截图（图片 / 录像）</label></div>
      {enabled && <>
        <label>所属游戏<select value={gameId} onChange={event => setGameId(event.target.value)}>
          <option value="auto">按 Steam 文件名自动分组</option><option value="">未指定游戏</option>
          {choices.map(game => <option key={game.id} value={game.id}>{gameLabel(game)}{game.name && game.steamAppId ? ` · Steam ${game.steamAppId}` : ""}</option>)}
        </select></label>
        <button className="button subtle" type="button" onClick={() => setNewGame(!newGame)}><Plus size={14} />新建游戏</button>
        {newGame && <div className="form-section"><label>游戏名称<input value={name} onChange={event => setName(event.target.value)} maxLength={200} /></label><label>Steam App ID（可选）<input value={appId} onChange={event => setAppId(event.target.value)} inputMode="numeric" /></label><button type="button" className="button" disabled={busy || (!name.trim() && !appId)} onClick={() => void create()}>创建并选择</button></div>}
        {asset && <label>截图 / 录像时间<input type="datetime-local" step="1" value={capturedAt} onChange={event => setCapturedAt(event.target.value)} /></label>}
        <p className="form-help">{gameId === "auto" ? "新归入的素材按 Steam 文件名识别游戏；时间优先读取文件名中的 _YYYYMMDDHHmmss_ 或末尾的 _YYYYMMDDHHmmss，否则取元数据中拍摄、创建与修改时间的最早值。游戏无法识别时进入未指定游戏，已归类素材保留原有信息。" : asset ? "时间优先读取文件名中的 _YYYYMMDDHHmmss_ 或末尾的 _YYYYMMDDHHmmss，否则取元数据中拍摄、创建与修改时间的最早值。可手动修改或清空，未知时间排在最后。" : "已归类素材保留各自的时间；新归入素材优先读取文件名中的年月日时分秒，否则取元数据中拍摄、创建与修改时间的最早值。"}</p>
      </>}
      {!enabled && <p className="form-help">移出游戏截图后回到全部素材；没有标签或收藏集时也会进入未整理。原件与其他关联保留，重复导入不会重新覆盖这一选择。</p>}
      {error && <div className="inline-error">{error}</div>}
      <footer className="dialog-footer"><button type="button" className="button" onClick={close}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy ? <RotateCw size={15} className="spin" /> : <Check size={15} />}保存</button></footer>
    </form>
  </Dialog>;
}
