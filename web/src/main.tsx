import { CSSProperties, StrictMode, useDeferredValue, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDownWideNarrow, Check, ChevronDown, CircleAlert, Download, Eye, EyeOff, Folder, Grid2X2, Group, Image, Inbox, Layers3, Menu, MoreHorizontal, Plus, RefreshCw, RotateCw, Search, SlidersHorizontal, Star, Tag, Trash2, Ungroup, Unlink, Upload, X } from "lucide-react";
import { api, Asset, AssetPage, base, bytes, Entity, Info, Job, MediaGroup, Patch, Scope, scoped, View } from "./api";
import { Dialog, Empty, isTextInput, stateNames } from "./components";
import { MediaCard } from "./MediaCard";
import { TagChip } from "./TagChip";
import { CollectionGallery, collectionEntries } from "./CollectionGallery";
import { GroupFormation } from "./MasonryGallery";
import { prepareGroupMedia } from "./groupMedia";
import { navigationPath, readNavigation } from "./navigation";
import { UploadPanel } from "./UploadPanel";
import { Viewer } from "./Viewer";
import * as importer from "./upload";
import "./style.css";

type Filter = { kind: string; format: string; aspect: string; minWidth: string; minHeight: string; maxWidth: string; maxHeight: string; minDuration: string; maxDuration: string; minSize: string; maxSize: string };
const emptyFilter: Filter = { kind: "", format: "", aspect: "", minWidth: "", minHeight: "", maxWidth: "", maxHeight: "", minDuration: "", maxDuration: "", minSize: "", maxSize: "" };
type Modal = { type: "upload" } | { type: "entity"; kind: "tags" | "collections"; entity?: Entity } | { type: "organize"; ids: string[] } | { type: "purge"; ids: string[] } | { type: "remove-entity"; kind: "tags" | "collections"; entity: Entity };
const viewLabels: Record<View, string> = { all: "全部素材", inbox: "未整理", starred: "星标", collections: "收藏集", tags: "标签", trash: "回收站", jobs: "任务中心" };

function App() {
  const [scope, setScope] = useState<Scope>("normal");
  const [navigation, setNavigation] = useState(() => readNavigation(window.location.pathname, base));
  const { view, tagId, collectionId } = navigation;
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [filters, setFilters] = useState<Filter>(emptyFilter);
  const [sort, setSort] = useState("newest");
  const [density, setDensity] = useState(225);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [groups, setGroups] = useState<MediaGroup[]>([]);
  const [groupPages, setGroupPages] = useState<Record<string, AssetPage>>({});
  const [expandedGroups, setExpandedGroups] = useState(new Set<string>());
  const [groupFormation, setGroupFormation] = useState<GroupFormation>();
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [info, setInfo] = useState<Info>();
  const [tags, setTags] = useState<Entity[]>([]);
  const [collections, setCollections] = useState<Entity[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const contentKey = JSON.stringify([scope, view, tagId, collectionId]);
  const [loadedKey, setLoadedKey] = useState("");
  const contentReady = loadedKey === contentKey;
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState(new Set<string>());
  const [selecting, setSelecting] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [viewer, setViewer] = useState<Asset | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const lastSelected = useRef<number>(-1);
  const pageToken = useRef(0);
  const selectionRequest = useRef<AbortController | null>(null);
  const galleryRequest = useRef<AbortController | null>(null);
  const loadMoreRequest = useRef<AbortController | null>(null);
  const loadMoreTarget = useRef<HTMLDivElement>(null);
  const polling = useRef(false);
  const uploadState = useSyncExternalStore(importer.subscribe, importer.snapshot);
  const uploads = uploadState.items.filter(item => item.scope === scope);
  const uploading = uploads.filter(item => ["waiting", "reading", "uploading", "verifying"].includes(item.state)).length;
  const notify = (message: string) => setToast(message);
  const changed = () => setRefresh(value => value + 1);
  const assetView = !["tags", "collections", "jobs"].includes(view);
  const hasMore = nextOffset !== null && nextOffset !== undefined && nextOffset < total;
  const canAutoLoadMore = assetView && contentReady && hasMore && !loading && !loadingMore && !loadMoreFailed && !error && !selectingAll && !busy && !modal && !viewer;
  const entries = collectionEntries(assets, collectionId ? groups : [], groupPages);
  const galleryAssets = entries.flatMap(entry => entry.asset ? [entry.asset] : expandedGroups.has(entry.group.id) ? entry.items : []);
  const galleryIndices = new Map(galleryAssets.map((asset, index) => [asset.id, index]));
  const selectedAssets = entries.flatMap(entry => entry.asset ? [entry.asset] : entry.items).filter(asset => selected.has(asset.id));
  const selectedAreStarred = selectedAssets.length === selected.size && selectedAssets.every(asset => asset.starred);
  const selectedInGroups = groups.some(group => group.assetIds.some(id => selected.has(id)));
  const allSelected = total > 0 && selected.size === total;
  const activeEntity = collectionId ? collections.find(item => item.id === collectionId) : tagId ? tags.find(item => item.id === tagId) : undefined;
  const title = activeEntity?.name || (collectionId ? "收藏集" : tagId ? "标签" : viewLabels[view]);
  const activeFilters = Object.entries(filters).filter(([, value]) => value);
  const tagDragKey = `${scope}:${view}:${tagId}:${collectionId}:${viewer?.id || ""}:${modal?.type || ""}`;
  const tagBusy = busy || loading || selectingAll;

  function cancelSelectAll() {
    selectionRequest.current?.abort();
    selectionRequest.current = null;
    setSelectingAll(false);
  }
  function exitSelection() {
    cancelSelectAll();
    setSelected(new Set()); setSelecting(false);
    lastSelected.current = -1;
  }
  function navigate(next: View, tag = "", collection = "", history: "push" | "replace" | "none" = "push") {
    const target = { view: next, tagId: tag, collectionId: collection };
    const path = navigationPath(target, base);
    if (history !== "none" && window.location.pathname !== path) {
      window.history[history === "replace" ? "replaceState" : "pushState"](null, "", path);
    }
    cancelSelectAll();
    setNavigation(target); setSelected(new Set()); setSelecting(false); setSidebarOpen(false); setViewer(null);
  }
  const restoreNavigationEvent = useEffectEvent(() => {
    const target = readNavigation(window.location.pathname, base);
    navigate(target.view, target.tagId, target.collectionId, "none");
  });
  useEffect(() => {
    const restore = () => restoreNavigationEvent();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  function switchScope() {
    navigate(view, "", "", "replace");
    setScope(value => value === "normal" ? "hidden" : "normal");
    setAssets([]); setGroups([]); setGroupPages({}); setInfo(undefined); setTags([]); setCollections([]); setJobs([]); setTotal(0); setNextOffset(null);
    setModal(null); setQuery(""); setFilters(emptyFilter); setFilterOpen(false); setToast("");
  }
  const switchScopeEvent = useEffectEvent(switchScope);
  const selectionKeyEvent = useEffectEvent((event: KeyboardEvent) => {
    if (event.repeat || event.altKey || modal || viewer) return;
    if (event.key === "Escape" && document.querySelector(".tag-drag-ghost")) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === "a" && !event.shiftKey && assetView && !isTextInput(event.target)) {
        event.preventDefault();
        void selectAll(false);
      }
      return;
    }
    if (event.key === "Escape" && (selecting || selected.size || selectingAll)) {
      event.preventDefault();
      exitSelection();
    }
  });
  useEffect(() => {
    let count = 0;
    let started = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) { count = 0; return; }
      selectionKeyEvent(event);
      if (event.ctrlKey || event.metaKey || event.altKey) { count = 0; return; }
      if (event.key === "Tab") event.preventDefault();
      if (event.repeat) return;
      const now = performance.now();
      if (event.key.toLowerCase() !== "q") { count = 0; return; }
      if (!count || now - started > 1500) { count = 0; started = now; }
      count++;
      if (count === 2) {
        count = 0;
        // Let native text input finish before clearing the previous scope's search.
        pending = setTimeout(() => switchScopeEvent(), 0);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); clearTimeout(pending); };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  function receiveFiles(files: File[], target = { scope, tagId, collectionId }) {
    const skipped = importer.addFiles(files, target.scope, target.tagId ? [target.tagId] : [], target.collectionId ? [target.collectionId] : []);
    setModal({ type: "upload" });
    if (skipped) notify(`已跳过 ${skipped} 个空文件或不支持的文件`);
  }
  const receiveFilesEvent = useEffectEvent(receiveFiles);
  const dropTargetEvent = useEffectEvent(() => ({ scope, tagId, collectionId }));
  useEffect(() => {
    let depth = 0;
    let internalDrag = false;
    const resetDrag = () => { depth = 0; setDragging(false); };
    // Browsers can expose page images as files during a native drag.
    const start = () => { internalDrag = true; resetDrag(); };
    const end = () => { internalDrag = false; resetDrag(); };
    const enter = (event: DragEvent) => { if (!internalDrag && event.dataTransfer?.types.includes("Files")) { event.preventDefault(); depth++; setDragging(true); } };
    const over = (event: DragEvent) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = internalDrag ? "none" : "copy"; } };
    const leave = (event: DragEvent) => { if (event.dataTransfer?.types.includes("Files")) { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); } };
    const drop = async (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault(); resetDrag();
      if (internalDrag) return;
      const target = dropTargetEvent();
      const items = Array.from(event.dataTransfer.items);
      const entries = items.map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry);
      if (entries.some(entry => entry.isDirectory)) {
        const files: File[] = [];
        const walk = async (entry: FileSystemEntry, prefix: string) => {
          if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
            Object.defineProperty(file, "webkitRelativePath", { value: prefix + file.name }); files.push(file);
          } else {
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            while (true) {
              const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
              if (!children.length) break;
              for (const child of children) await walk(child, `${prefix}${entry.name}/`);
            }
          }
        };
        try { for (const entry of entries) await walk(entry, ""); receiveFilesEvent(files, target); }
        catch (error) { notify(error instanceof Error ? error.message : "文件夹读取失败"); }
      } else receiveFilesEvent(Array.from(event.dataTransfer.files), target);
    };
    const paste = (event: ClipboardEvent) => { if (event.clipboardData?.files.length) { event.preventDefault(); receiveFilesEvent(Array.from(event.clipboardData.files)); } };
    window.addEventListener("dragstart", start, true); window.addEventListener("dragend", end); window.addEventListener("dragenter", enter); window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop); window.addEventListener("paste", paste);
    return () => { window.removeEventListener("dragstart", start, true); window.removeEventListener("dragend", end); window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); window.removeEventListener("paste", paste); };
  }, []);
  useEffect(() => {
    window.addEventListener("curio-library-changed", changed);
    return () => window.removeEventListener("curio-library-changed", changed);
  }, []);
  function assetPath(offset = 0, limit = 100, grouped = true) {
    const params = new URLSearchParams({ scope, limit: String(limit), offset: String(offset), sort });
    if (search.trim()) params.set("q", search.trim());
    if (tagId) params.set("tag", tagId);
    if (collectionId) { params.set("collection", collectionId); if (grouped) params.set("grouped", "1"); }
    if (view === "starred") params.set("starred", "1");
    if (view === "inbox") params.set("unorganized", "1");
    if (view === "trash") params.set("trash", "1");
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, key === "minSize" || key === "maxSize" ? String(Number(value) * 1024 * 1024) : value);
    return `assets?${params}`;
  }
  function groupsPath() { return assetPath().replace("assets?", `collections/${collectionId}/groups?`); }
  async function loadPages(signal: AbortSignal) {
    const wanted = Math.max(100, assets.length);
    let page = await api<AssetPage>(assetPath(0, Math.min(240, wanted)), undefined, undefined, signal);
    const items = [...page.items];
    while (items.length < wanted && page.nextOffset !== null && page.nextOffset !== undefined) {
      page = await api<AssetPage>(assetPath(page.nextOffset, Math.min(240, wanted - items.length)), undefined, undefined, signal);
      if (!page.items.length) break;
      items.push(...page.items);
    }
    return { ...page, items };
  }
  async function reloadGallery(signal: AbortSignal, token: number) {
    const [content, groupList] = await Promise.all([
      loadPages(signal),
      collectionId ? api<{ items: MediaGroup[] }>(groupsPath(), undefined, undefined, signal) : Promise.resolve({ items: [] })
    ]);
    const prepared = await prepareGroupMedia(content.items, groupList.items, assetPath(), signal);
    if (signal.aborted || token !== pageToken.current) return;
    setAssets(content.items); setTotal(content.total); setNextOffset(content.nextOffset);
    setGroups(groupList.items); setGroupPages(prepared);
    const available = new Set([...content.items.map(asset => asset.id), ...groupList.items.flatMap(group => group.assetIds)]);
    setSelected(previous => new Set([...previous].filter(id => available.has(id))));
    lastSelected.current = -1;
  }
  useEffect(() => {
    const controller = new AbortController();
    loadMoreRequest.current?.abort(); loadMoreRequest.current = null;
    if (galleryRequest.current) {
      galleryRequest.current.abort(); galleryRequest.current = null; setBusy(false);
    }
    setGroupFormation(undefined);
    cancelSelectAll();
    pageToken.current++;
    lastSelected.current = -1;
    setLoading(true); setLoadingMore(false); setLoadMoreFailed(false); setError("");
    const load = async () => {
      try {
        const [information, tagList, collectionList, content, groupList] = await Promise.all([
          api<Info>(scoped("info", scope), undefined, undefined, controller.signal),
          api<{ items: Entity[] }>(scoped("tags", scope), undefined, undefined, controller.signal),
          api<{ items: Entity[] }>(scoped("collections", scope), undefined, undefined, controller.signal),
          assetView ? loadPages(controller.signal) : view === "jobs" ? api<{ items: Job[] }>(scoped("jobs", scope), undefined, undefined, controller.signal) : Promise.resolve(null),
          collectionId ? api<{ items: MediaGroup[] }>(groupsPath(), undefined, undefined, controller.signal) : Promise.resolve({ items: [] })
        ]);
        const prepared = assetView && content && "total" in content ? await prepareGroupMedia(content.items, groupList.items, assetPath(), controller.signal) : {};
        if (controller.signal.aborted) return;
        setLoadedKey(contentKey);
        setInfo(information); setTags(tagList.items || []); setCollections(collectionList.items || []);
        setGroups(groupList.items);
        setGroupPages(prepared);
        if (assetView && content && "total" in content) {
          setAssets(content.items); setTotal(content.total); setNextOffset(content.nextOffset);
          const available = new Set([...content.items.map(asset => asset.id), ...groupList.items.flatMap(group => group.assetIds)]);
          setSelected(previous => new Set([...previous].filter(id => available.has(id))));
        }
        if (view === "jobs" && content && !("total" in content)) setJobs(content.items);
        if (viewer) {
          try { const current = await api<Asset>(scoped(`assets/${viewer.id}`, scope), undefined, undefined, controller.signal); if (!controller.signal.aborted) setViewer(current); }
          catch { if (!controller.signal.aborted) setViewer(null); }
        }
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    return () => { controller.abort(); selectionRequest.current?.abort(); galleryRequest.current?.abort(); loadMoreRequest.current?.abort(); };
  }, [scope, view, tagId, collectionId, search, filters, sort, refresh]);
  const poll = useEffectEvent(async () => {
    if (polling.current || galleryRequest.current) return;
    polling.current = true;
    const token = pageToken.current;
    const polledIds = [...new Set([...assets, ...Object.values(groupPages).flatMap(page => page.items)].map(asset => asset.id))].slice(0, 2000);
    const signal = AbortSignal.timeout(15000);
    try {
      const [information, tagList, collectionList, content, currentViewer, groupList] = await Promise.all([
        api<Info>(scoped("info", scope), undefined, undefined, signal),
        api<{ items: Entity[] }>(scoped("tags", scope), undefined, undefined, signal),
        api<{ items: Entity[] }>(scoped("collections", scope), undefined, undefined, signal),
        assetView && polledIds.length ? api<AssetPage>(`${assetPath(0, 2000)}&ids=${polledIds.join(",")}`, undefined, undefined, signal) : view === "jobs" ? api<{ items: Job[] }>(scoped("jobs", scope), undefined, undefined, signal) : Promise.resolve(null),
        viewer ? api<Asset>(scoped(`assets/${viewer.id}`, scope), undefined, undefined, signal).catch(() => null) : Promise.resolve(null),
        collectionId ? api<{ items: MediaGroup[] }>(groupsPath(), undefined, undefined, signal) : Promise.resolve({ items: [] })
      ]);
      const prepared = await prepareGroupMedia(content && "total" in content ? content.items : [...assets, ...Object.values(groupPages).flatMap(page => page.items)], groupList.items, assetPath(), signal);
      if (token !== pageToken.current) return;
      setInfo(information); setTags(tagList.items || []); setCollections(collectionList.items || []);
      setGroups(groupList.items);
      setGroupPages(prepared);
      if (assetView && content && "total" in content) {
        const updated = new Map(content.items.map(item => [item.id, item]));
        setAssets(previous => previous.filter(asset => !polledIds.includes(asset.id) || updated.has(asset.id)).map(asset => updated.get(asset.id) || asset));
        setSelected(previous => new Set([...previous].filter(id => !polledIds.includes(id) || updated.has(id))));
      } else if (view === "jobs" && content && !("total" in content)) setJobs(content.items);
      if (viewer) setViewer(currentViewer);
    } catch { /* The normal refresh action remains available after a transient poll failure. */ }
    finally { polling.current = false; }
  });
  useEffect(() => {
    if (!info?.queued) return;
    const timer = setInterval(() => void poll(), 5000);
    return () => clearInterval(timer);
  }, [info?.queued]);
  async function loadMore() {
    if (!contentReady || !hasMore || nextOffset === null || loading || error || loadingMore || loadMoreRequest.current || selectingAll || busy) return;
    const controller = new AbortController();
    loadMoreRequest.current = controller;
    setLoadingMore(true); setLoadMoreFailed(false);
    const token = pageToken.current;
    try {
      const result = await api<AssetPage>(assetPath(nextOffset), undefined, undefined, controller.signal);
      if (controller.signal.aborted || token !== pageToken.current) return;
      setAssets(previous => [...previous, ...result.items.filter(item => !previous.some(asset => asset.id === item.id))]);
      setNextOffset(result.nextOffset); setTotal(result.total);
    } catch (error) {
      if (!controller.signal.aborted && token === pageToken.current) {
        setLoadMoreFailed(true);
        notify(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (loadMoreRequest.current === controller) loadMoreRequest.current = null;
      if (token === pageToken.current) setLoadingMore(false);
    }
  }
  const loadMoreEvent = useEffectEvent(loadMore);
  useEffect(() => {
    const target = loadMoreTarget.current;
    if (!canAutoLoadMore || !target) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMoreEvent();
    }, { rootMargin: "0px 0px 100px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [canAutoLoadMore, nextOffset, contentKey]);
  function toggleGroup(group: MediaGroup) {
    lastSelected.current = -1;
    setExpandedGroups(previous => { const next = new Set(previous); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; });
  }
  async function selectGroup(group: MediaGroup) {
    if (busy || loading || selectingAll) return;
    if (group.assetIds.length > 2000) { notify("每次最多选择 2000 项，请展开后选择部分素材"); return; }
    cancelSelectAll();
    setSelecting(true);
    lastSelected.current = -1;
    if (group.assetIds.every(id => selected.has(id))) {
      setSelected(previous => new Set([...previous].filter(id => !group.assetIds.includes(id))));
      return;
    }
    if (new Set([...selected, ...group.assetIds]).size > 2000) { notify("每次最多选择 2000 项"); return; }
    const controller = new AbortController();
    selectionRequest.current = controller;
    setSelectingAll(true);
    const token = pageToken.current;
    try {
      const items: Asset[] = [];
      let page: AssetPage;
      let offset = 0;
      do {
        page = await api<AssetPage>(`${assetPath(offset, 240, false)}&group=${group.id}`, undefined, undefined, controller.signal);
        if (controller.signal.aborted || token !== pageToken.current) return;
        if (page.total > 2000) throw new Error("每次最多选择 2000 项，请展开后选择部分素材");
        items.push(...page.items);
        offset = page.nextOffset ?? 0;
      } while (page.nextOffset != null);
      setGroupPages(previous => ({ ...previous, [group.id]: { ...page, items } }));
      setSelected(previous => new Set([...previous, ...items.map(asset => asset.id)]));
    } catch (error) { if (!controller.signal.aborted) notify(error instanceof Error ? error.message : String(error)); }
    finally { if (selectionRequest.current === controller) { selectionRequest.current = null; setSelectingAll(false); } }
  }
  async function editGroup(group: MediaGroup | null, action: "create" | "add" | "remove" | "dissolve") {
    if (busy || loading || selectingAll) return;
    const ids = [...selected];
    if (action !== "dissolve" && (!ids.length || ids.length > 2000)) return;
    if (action === "create" && ids.length < 2) return;
    const controller = new AbortController();
    galleryRequest.current = controller;
    const token = ++pageToken.current;
    setLoadingMore(false);
    setBusy(true);
    let saved = false;
    try {
      const path = `collections/${collectionId}/groups${group ? `/${group.id}` : ""}`;
      const body = action === "create" ? { ids } : action === "add" ? { addIds: ids } : action === "remove" ? { removeIds: ids } : undefined;
      const result = await api<{ id?: string }>(scoped(path, scope), body, action === "create" ? "POST" : action === "dissolve" ? "DELETE" : "PATCH");
      saved = true;
      if (controller.signal.aborted || token !== pageToken.current) return;
      // Group edits change gallery placement, not memberships or library counters.
      await reloadGallery(controller.signal, token);
      if (controller.signal.aborted || token !== pageToken.current) return;
      exitSelection();
      if (action === "create" && result.id) {
        const id = result.id;
        setExpandedGroups(previous => { const next = new Set(previous); next.delete(id); return next; });
        setGroupFormation({ id, assetIds: ids });
      } else if (action === "add") {
        setExpandedGroups(previous => new Set(previous).add(group!.id));
      }
      notify(({ create: "已组成一组", add: "已加入这组", remove: "已移出分组，素材仍在收藏集中", dissolve: "分组已解散，全部素材已保留" })[action]);
    } catch (error) {
      if (!controller.signal.aborted && token === pageToken.current) {
        if (saved) exitSelection();
        notify(saved ? "分组已保存，界面同步失败，请点击刷新" : error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (galleryRequest.current === controller) { galleryRequest.current = null; setBusy(false); }
    }
  }
  async function selectAll(toggle = true) {
    if (loading || loadingMore || selectingAll || busy || !total || error) return;
    if (allSelected) { if (toggle) setSelected(new Set()); else setSelecting(true); return; }
    if (total > 2000) { notify("每次最多选择 2000 项，请缩小筛选范围后全选"); return; }
    const controller = new AbortController();
    selectionRequest.current = controller;
    const token = pageToken.current;
    setSelecting(true);
    setSelectingAll(true);
    try {
      const items: Asset[] = [];
      let offset = 0;
      let page: AssetPage;
      do {
        page = await api<AssetPage>(assetPath(offset, 240, false), undefined, undefined, controller.signal);
        if (controller.signal.aborted || token !== pageToken.current) return;
        if (page.total > 2000) throw new Error("每次最多选择 2000 项，请缩小筛选范围后全选");
        items.push(...page.items);
        offset = page.nextOffset ?? 0;
      } while (page.nextOffset != null);
      setAssets(items); setTotal(page.total); setNextOffset(null);
      setSelecting(true); setSelected(new Set(items.map(asset => asset.id)));
      lastSelected.current = -1;
    } catch (error) {
      if (!controller.signal.aborted && token === pageToken.current) notify(error instanceof Error ? error.message : String(error));
    } finally {
      if (selectionRequest.current === controller) { selectionRequest.current = null; setSelectingAll(false); }
    }
  }
  async function patch(ids: string[], value: Patch, message: string) {
    if (busy || !ids.length) return;
    setBusy(true);
    try { await api(scoped("assets", scope), { ids, ...value }, "PATCH"); setSelected(new Set()); changed(); notify(message); }
    catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function changeTag(assetId: string, tag: Entity, remove: boolean) {
    if (tagBusy) return;
    const asset = [...assets, ...Object.values(groupPages).flatMap(page => page.items), ...(viewer ? [viewer] : [])].find(item => item.id === assetId);
    if (!remove && asset?.tags.some(item => item.id === tag.id)) { notify(`已有标签“${tag.name}”`); return; }
    const controller = new AbortController();
    galleryRequest.current = controller;
    const token = ++pageToken.current;
    setLoadingMore(false);
    setBusy(true);
    let saved = false;
    try {
      const updated = await api<Asset>(scoped(`assets/${assetId}`, scope), remove ? { removeTagIds: [tag.id] } : { addTagIds: [tag.id] }, "PATCH");
      saved = true;
      if (controller.signal.aborted || token !== pageToken.current) return;
      const replace = (items: Asset[]) => items.map(item => item.id === updated.id ? updated : item);
      setAssets(replace);
      setGroupPages(previous => Object.fromEntries(Object.entries(previous).map(([id, page]) => [id, { ...page, items: replace(page.items) }])));
      const sameScope = updated.effectiveHidden === (scope === "hidden");
      setViewer(previous => previous?.id === updated.id ? sameScope ? updated : null : previous);
      if (!remove) setSidebarOpen(false);
      // Tags affect gallery membership only through visibility, inbox or tag/search filters.
      const affectsFilter = !sameScope || view === "inbox" || !!search.trim() || (!!tagId && !updated.tags.some(item => item.id === tagId));
      const [information, tagList, collectionList] = await Promise.all([
        api<Info>(scoped("info", scope), undefined, undefined, controller.signal),
        api<{ items: Entity[] }>(scoped("tags", scope), undefined, undefined, controller.signal),
        api<{ items: Entity[] }>(scoped("collections", scope), undefined, undefined, controller.signal),
        affectsFilter ? reloadGallery(controller.signal, token) : Promise.resolve()
      ]);
      if (controller.signal.aborted || token !== pageToken.current) return;
      setInfo(information); setTags(tagList.items || []); setCollections(collectionList.items || []);
      notify(`${remove ? "已移除" : "已添加"}标签“${tag.name}”`);
    } catch (error) {
      if (!controller.signal.aborted && token === pageToken.current) notify(saved ? "标签已保存，界面同步失败，请点击刷新" : error instanceof Error ? error.message : String(error));
    } finally {
      if (galleryRequest.current === controller) { galleryRequest.current = null; setBusy(false); }
    }
  }
  async function retry(ids: string[]) {
    try { await api("assets/retry", { ids }); changed(); notify("已重新加入处理队列"); }
    catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  }
  function select(asset: Asset, index: number, range = false) {
    cancelSelectAll();
    setSelected(previous => {
      const next = new Set(previous);
      if (range && lastSelected.current >= 0) for (let i = Math.min(index, lastSelected.current); i <= Math.max(index, lastSelected.current); i++) next.add(galleryAssets[i].id);
      else if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id);
      return next;
    });
    lastSelected.current = index;
  }
  const viewerIndex = viewer ? galleryAssets.findIndex(item => item.id === viewer.id) : -1;
  function renderMedia(asset: Asset, groupOpen?: boolean) {
    const index = galleryIndices.get(asset.id) ?? -1;
    return <MediaCard key={asset.id} asset={asset} tagId={tagId} collectionId={collectionId} selected={selected.has(asset.id)} selecting={selecting || !!selected.size} active={groupOpen !== false} loading={groupOpen === undefined ? "lazy" : "eager"} open={event => { if (selecting || selected.size || event.ctrlKey || event.metaKey || event.shiftKey) select(asset, index, event.shiftKey); else setViewer(asset); }} select={range => select(asset, index, range)} tagDragKey={tagDragKey} tagBusy={tagBusy} changeTag={(id, tag, remove) => void changeTag(id, tag, remove)} />;
  }
  const gallery = collectionId ? <CollectionGallery entries={entries} expanded={expandedGroups} formation={groupFormation} selected={selected} selecting={selecting || !!selected.size} busy={busy || loading || selectingAll} render={renderMedia} toggle={toggleGroup} selectGroup={selectGroup} add={group => void editGroup(group, "add")} dissolve={group => void editGroup(group, "dissolve")} /> : <div className={`gallery ${selecting ? "selecting" : ""}`}>{assets.map(asset => renderMedia(asset))}</div>;
  return <div className={`app ${scope === "hidden" ? "hidden-mode" : ""} ${assetView && (selecting || selected.size) ? "has-selection" : ""}`}>
    <input className="file-input" ref={picker} type="file" multiple accept="image/*,video/*,.svg,.ico,.apng,.mkv,.webm" onChange={event => { receiveFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
    <input className="file-input" ref={folderPicker} type="file" multiple {...{ webkitdirectory: "" }} onChange={event => { receiveFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
    {sidebarOpen && <button className="sidebar-shade" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}><button className="brand" onClick={() => navigate("all")} aria-label="Curio 首页"><img src={`${base}favicon.svg`} alt="" /><span>Curio</span></button>
      <nav className="navigation">
        <Nav icon={<Grid2X2 size={18} />} label="全部素材" active={view === "all" && !tagId && !collectionId} count={info?.total} click={() => navigate("all")} />
        <Nav icon={<Inbox size={18} />} label="未整理" active={view === "inbox"} count={info?.unorganized} click={() => navigate("inbox")} />
        <Nav icon={<Star size={18} />} label="星标" active={view === "starred"} count={info?.starred} click={() => navigate("starred")} />
      </nav>
      <div className="sidebar-section"><div className="sidebar-section-heading"><button onClick={() => navigate("collections")}>收藏集</button><button className="icon-button" aria-label="新建收藏集" onClick={() => setModal({ type: "entity", kind: "collections" })}><Plus size={14} /></button></div><div className="sidebar-entities">{collections.slice(0, 7).map(collection => <button key={collection.id} className={collectionId === collection.id ? "active" : ""} onClick={() => navigate("all", "", collection.id)}><Folder size={15} /><span>{collection.name}</span><small>{collection.count}</small></button>)}{!collections.length && <button className="sidebar-placeholder" onClick={() => setModal({ type: "entity", kind: "collections" })}>新建一个主题收藏集</button>}{collections.length > 7 && <button className="sidebar-more" onClick={() => navigate("collections")}>查看全部 <ChevronDown size={12} /></button>}</div></div>
      <div className="sidebar-section"><div className="sidebar-section-heading"><button onClick={() => navigate("tags")}>标签</button><button className="icon-button" aria-label="新建标签" onClick={() => setModal({ type: "entity", kind: "tags" })}><Plus size={14} /></button></div><div className="sidebar-tag-list">{tags.slice(0, 10).map(tag => <TagChip className={tagId === tag.id ? "active" : ""} key={tag.id} tag={tag} cancelKey={tagDragKey} disabled={tagBusy} click={() => navigate("all", tag.id)} remove={() => setModal({ type: "remove-entity", kind: "tags", entity: tag })} change={(id, tag, remove) => void changeTag(id, tag, remove)} />)}{!tags.length && <button className="sidebar-placeholder" onClick={() => setModal({ type: "entity", kind: "tags" })}>添加用途或主题标签</button>}{tags.length > 10 && <button className="sidebar-more" onClick={() => navigate("tags")}>全部标签</button>}</div></div>
      <div className="sidebar-bottom">{!!uploading && <button className="transfer-mini" onClick={() => setModal({ type: "upload" })}><Upload size={18} /><div><strong>{uploadState.paused ? "收集已暂停" : "正在收集素材"}</strong><small>{uploading} 个文件待完成</small></div></button>}<nav className="navigation secondary"><Nav icon={<Layers3 size={17} />} label="任务中心" active={view === "jobs"} count={(info?.queued || 0) + (info?.errors || 0) || undefined} click={() => navigate("jobs")} /><Nav icon={<Trash2 size={17} />} label="回收站" active={view === "trash"} count={info?.trash || undefined} click={() => navigate("trash")} /></nav><div className="sidebar-storage"><span className="mode-dot" /><span>{info ? `${info.total.toLocaleString()} 个素材 · ${bytes(info.bytes)}` : "连接素材库…"}</span></div></div>
    </aside>
    <main className="main"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebarOpen(true)}><Menu size={22} /></button><span className="desktop-label">视觉收藏库</span><span className="crumb-separator">/</span><span>{title}</span></div><div className="top-actions"><label className="search"><Search size={16} /><input type="search" value={query} onChange={event => { setQuery(event.target.value); if (!assetView) navigate("all"); }} placeholder="搜索名称、标签、备注" aria-label="搜索素材" />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={14} /></button>}</label><button className="button primary collect-button" onClick={() => setModal({ type: "upload" })}><Plus size={17} /><span>收集素材</span></button></div></header>
      {scope === "hidden" && <div className="hidden-banner"><span><EyeOff size={15} />隐藏模式</span><button onClick={switchScope}>返回普通模式 <Eye size={14} /></button></div>}
      <div className="page"><div className="page-heading"><div><div className="page-caption">{activeEntity ? collectionId ? "收藏集" : "标签" : "Curio"}</div><h1>{title}{!loading && <span className="heading-count">{assetView ? total.toLocaleString() : view === "collections" ? collections.length : view === "tags" ? tags.length : jobs.length}</span>}</h1></div><div className="heading-actions">{activeEntity && <button className="button" onClick={() => setModal({ type: "entity", kind: collectionId ? "collections" : "tags", entity: activeEntity })}><MoreHorizontal size={16} />管理</button>}{(view === "collections" || view === "tags") && <button className="button" onClick={() => setModal({ type: "entity", kind: view })}><Plus size={16} />新建{view === "collections" ? "收藏集" : "标签"}</button>}<button className="icon-button" aria-label="刷新" title="刷新" onClick={changed}><RefreshCw size={17} className={loading ? "spin" : ""} /></button></div></div>
        {assetView && <><div className="library-toolbar"><div className="kind-tabs">{[["", "全部"], ["image", "图片"], ["animation", "动图"], ["video", "视频"]].map(([kind, label]) => <button key={kind} className={filters.kind === kind ? "active" : ""} onClick={() => setFilters({ ...filters, kind })}>{label}</button>)}</div><div className="toolbar-right"><label className="sort"><ArrowDownWideNarrow size={15} /><select value={sort} aria-label="排序" onChange={event => setSort(event.target.value)}><option value="newest">最近收集</option><option value="oldest">最早收集</option><option value="name">名称</option><option value="size">文件大小</option></select></label><button className={`filter-toggle ${filterOpen || activeFilters.some(([key]) => key !== "kind") ? "active" : ""}`} onClick={() => setFilterOpen(!filterOpen)}><SlidersHorizontal size={15} />筛选</button><button className={`icon-button ${selecting ? "is-active" : ""}`} title="批量选择" aria-label="批量选择" onClick={() => { cancelSelectAll(); setSelecting(!selecting); setSelected(new Set()); }}><Check size={17} /></button><label className="density" title="显示密度"><Grid2X2 size={13} /><input type="range" min="140" max="340" value={density} aria-label="缩略图大小" onChange={event => setDensity(Number(event.target.value))} /></label></div></div>
          {filterOpen && <FilterPanel value={filters} change={setFilters} clear={() => setFilters(emptyFilter)} />}
          {!!activeFilters.filter(([key]) => key !== "kind").length && <div className="active-filters">{activeFilters.filter(([key]) => key !== "kind").map(([key, value]) => <button key={key} onClick={() => setFilters({ ...filters, [key]: "" })}>{filterLabel(key, value)}<X size={11} /></button>)}<button className="clear" onClick={() => setFilters({ ...emptyFilter, kind: filters.kind })}>清除筛选</button></div>}
        </>}
        {error && contentReady && <div className="inline-error" role="alert">更新失败，仍显示上次内容：{error} <button className="button" onClick={changed}>重试</button></div>}
        {error && !contentReady ? <Empty icon={<CircleAlert size={30} />} title="暂时无法读取素材库" description={error}><button className="button" onClick={changed}><RotateCw size={15} />重试</button></Empty> : !contentReady && assetView ? <div className="skeleton-gallery" style={{ "--tile-width": `${density}px` } as CSSProperties}>{Array.from({ length: 12 }, (_, index) => <div key={index} style={{ aspectRatio: [0.85, 1.25, 1, 0.68][index % 4] }} />)}</div> : assetView ? assets.length ? <>
          {collectionId && !groups.length && <p className="group-help"><Layers3 size={13} />选中多个素材，即可组成一组，无需命名。</p>}
          <div className="gallery-results" aria-busy={loading} inert={loading || !!error} style={{ "--tile-width": `${density}px` } as CSSProperties}>{gallery}</div>
          {hasMore && <div className="load-more" ref={loadMoreTarget}><button className="button" onClick={() => void loadMore()} disabled={loading || !!error || loadingMore || selectingAll || busy}>{loadingMore && <RotateCw size={15} className="spin" />}{loadingMore ? "正在加载…" : loadMoreFailed ? "重试加载" : "加载更多"} {!collectionId && <span>{assets.length} / {total}</span>}</button></div>}
        </> : <Empty icon={view === "trash" ? <Trash2 size={30} /> : search || activeFilters.length ? <Search size={30} /> : view === "inbox" ? <Inbox size={30} /> : view === "starred" ? <Star size={30} /> : <Image size={32} strokeWidth={1.3} />} title={search || activeFilters.length ? "没有找到匹配的素材" : view === "trash" ? "回收站是空的" : view === "inbox" ? "没有待整理的素材" : view === "starred" ? "还没有星标素材" : scope === "hidden" ? "隐藏模式暂无素材" : activeEntity ? "这里还没有素材" : "开始你的视觉收藏"} description={search || activeFilters.length ? "试试其他关键词，或减少筛选条件。" : view === "trash" ? "移除的素材会先保留在这里，可以随时恢复。" : view === "starred" ? "给常用或喜欢的素材添加星标，方便再次找到。" : view === "inbox" ? "没有标签或收藏集的素材会显示在这里，添加任意一个即可完成整理。" : "图标、头像、壁纸、梗图、截图和录像，都可以收集到这里。"}>{!["trash", "starred"].includes(view) && !search && !activeFilters.length && <button className="button primary" onClick={() => setModal({ type: "upload" })}><Plus size={17} />收集素材</button>}</Empty> : view === "collections" || view === "tags" ? <EntityGrid items={view === "collections" ? collections : tags} kind={view} open={entity => navigate("all", view === "tags" ? entity.id : "", view === "collections" ? entity.id : "")} edit={entity => setModal({ type: "entity", kind: view, entity })} remove={entity => setModal({ type: "remove-entity", kind: view, entity })} create={() => setModal({ type: "entity", kind: view })} /> : <Jobs items={jobs} retry={retry} open={async id => { try { setViewer(await api<Asset>(scoped(`assets/${id}`, scope))); } catch (error) { notify(error instanceof Error ? error.message : String(error)); } }} />}
      </div>
    </main>
    {assetView && (selecting || !!selected.size) && <div className="selection-bar" inert={loading || !!error || !contentReady}>
      <button className="icon-button" aria-label="退出选择" title="退出选择 (Esc)" onClick={exitSelection}><X size={17} /></button>
      <strong>已选 {selected.size} 项</strong>
      <button className="button subtle" title="全选当前筛选结果，包含尚未加载的素材" disabled={loading || loadingMore || selectingAll || busy || !total || !!error} onClick={() => void selectAll()}>{selectingAll ? <><RotateCw size={14} className="spin" />正在全选</> : allSelected ? "取消全选" : "全选"}</button>
      {!!selected.size && !selectingAll && <><span className="selection-divider" />{view !== "trash" ? <>
        {collectionId && <><button className="button group-create" title="将所选素材组成无名称的分组" disabled={busy || loading || selected.size < 2 || selected.size > 2000} onClick={() => void editGroup(null, "create")}><Group size={15} />组成一组</button>{selectedInGroups && <button className="button" disabled={busy || loading} onClick={() => void editGroup(null, "remove")}><Ungroup size={15} />移出分组</button>}</>}
        <button className="button" disabled={busy} onClick={() => setModal({ type: "organize", ids: [...selected] })}><Tag size={15} /><span>整理</span></button>{(collectionId || tagId) && <button className="button" title="仅移除当前关联，保留素材与其他标签、收藏集" disabled={busy} onClick={() => void patch([...selected], collectionId ? { removeCollectionIds: [collectionId] } : { removeTagIds: [tagId] }, collectionId ? "已移出当前收藏集" : "已移出当前标签")}><Unlink size={15} />{collectionId ? "移出当前收藏集" : "移出当前标签"}</button>}<button className="icon-button" title={selectedAreStarred ? "取消星标" : "添加星标"} aria-label={selectedAreStarred ? "取消星标" : "添加星标"} disabled={busy} onClick={() => void patch([...selected], { starred: !selectedAreStarred }, "星标已更新")}><Star size={17} /></button><button className="icon-button" title="单独隐藏" aria-label="单独隐藏" disabled={busy} onClick={() => void patch([...selected], { hidden: true }, "已标记隐藏")}><EyeOff size={17} /></button><button className="icon-button" title="取消单独隐藏" aria-label="取消单独隐藏" disabled={busy} onClick={() => void patch([...selected], { hidden: false }, "已取消单独隐藏；标签或收藏集的隐藏仍会生效")}><Eye size={17} /></button><a className="icon-button" title="打包下载" aria-label="打包下载" href={`${base}api/download?ids=${[...selected].join(",")}`}><Download size={17} /></a><button className="icon-button danger" title="移入回收站" aria-label="移入回收站" disabled={busy} onClick={() => void patch([...selected], { trash: true }, "已移入回收站")}><Trash2 size={17} /></button></> : <><button className="button" disabled={busy} onClick={() => void patch([...selected], { trash: false }, "素材已恢复")}><RotateCw size={15} />恢复</button><button className="button danger" disabled={busy} onClick={() => setModal({ type: "purge", ids: [...selected] })}><Trash2 size={15} />永久删除</button></>}</>}
    </div>}
    {viewer && <Viewer asset={viewer} scope={scope} tags={tags} collections={collections} close={() => setViewer(null)} previous={viewerIndex > 0 ? () => setViewer(galleryAssets[viewerIndex - 1]) : undefined} next={viewerIndex >= 0 && viewerIndex < galleryAssets.length - 1 ? () => setViewer(galleryAssets[viewerIndex + 1]) : undefined} changed={changed} notify={notify} tagDragKey={tagDragKey} tagBusy={tagBusy} changeTag={(id, tag, remove) => void changeTag(id, tag, remove)} />}
    {modal?.type === "upload" && <UploadPanel scope={scope} close={() => setModal(null)} pick={() => picker.current?.click()} folder={() => folderPicker.current?.click()} />}
    {modal?.type === "entity" && <EntityEditor kind={modal.kind} entity={modal.entity} scope={scope} close={() => setModal(null)} saved={() => { changed(); setModal(null); notify("已保存"); }} remove={modal.entity && modal.kind === "collections" ? () => setModal({ type: "remove-entity", kind: modal.kind, entity: modal.entity! }) : undefined} />}
    {modal?.type === "organize" && <Organize ids={modal.ids} tags={tags} collections={collections} close={() => setModal(null)} save={async value => { await api(scoped("assets", scope), { ids: modal.ids, ...value }, "PATCH"); setModal(null); setSelected(new Set()); changed(); notify("标签与收藏集已更新"); }} />}
    {modal?.type === "purge" && <Purge count={modal.ids.length} close={() => setModal(null)} confirm={async () => { await api("assets/purge", { ids: modal.ids, confirm: true }); setModal(null); setSelected(new Set()); changed(); notify("永久删除已提交"); }} />}
    {modal?.type === "remove-entity" && <RemoveEntity kind={modal.kind} entity={modal.entity} close={() => setModal(null)} confirm={async () => { await api(`${modal.kind}/${modal.entity.id}`, undefined, "DELETE"); setModal(null); if (tagId === modal.entity.id || collectionId === modal.entity.id) navigate("all"); changed(); notify("已移除，不影响原件"); }} />}
    {dragging && <div className="drop-overlay"><Upload size={42} strokeWidth={1.4} /><strong>松开即可收集</strong><span>{scope === "hidden" ? "保存到隐藏模式" : "保存到普通模式"}</span></div>}
    {toast && <div className="toast" role="status"><Check size={16} /><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast("")}><X size={14} /></button></div>}
  </div>;
}
function Nav({ icon, label, count, active, click }: { icon: React.ReactNode; label: string; count?: number; active: boolean; click: () => void }) {
  return <button className={active ? "active" : ""} onClick={click}>{icon}<span>{label}</span>{count !== undefined && <small>{count.toLocaleString()}</small>}</button>;
}
function filterLabel(key: string, value: string) {
  const names: Record<string, string> = { format: "格式", aspect: "比例", minWidth: "最小宽度", minHeight: "最小高度", maxWidth: "最大宽度", maxHeight: "最大高度", minDuration: "最短时长", maxDuration: "最长时长", minSize: "最小大小", maxSize: "最大大小" };
  const text = key === "aspect" ? ({ square: "正方形", landscape: "横向", portrait: "竖向" })[value] : value;
  return `${names[key] || key}：${text}${key.includes("Size") ? " MB" : key.includes("Duration") ? " 秒" : ""}`;
}
function FilterPanel({ value, change, clear }: { value: Filter; change: (next: Filter) => void; clear: () => void }) {
  const number = (key: keyof Filter, label: string, placeholder: string) => <label>{label}<input type="number" min="0" value={value[key]} placeholder={placeholder} onChange={event => change({ ...value, [key]: event.target.value })} /></label>;
  return <section className="filter-panel"><div className="filter-grid"><label>格式<select value={value.format} onChange={event => change({ ...value, format: event.target.value })}><option value="">全部格式</option>{["jpg", "jpeg", "png", "webp", "gif", "apng", "svg", "ico", "avif", "mp4", "mov", "mkv", "webm"].map(format => <option key={format} value={format}>{format.toUpperCase()}</option>)}</select></label><label>画面比例<select value={value.aspect} onChange={event => change({ ...value, aspect: event.target.value })}><option value="">全部比例</option><option value="square">正方形</option><option value="landscape">横向</option><option value="portrait">竖向</option></select></label>{number("minWidth", "最小宽度", "像素")}{number("minHeight", "最小高度", "像素")}{number("maxWidth", "最大宽度", "像素")}{number("maxHeight", "最大高度", "像素")}{number("minDuration", "最短时长", "秒")}{number("maxDuration", "最长时长", "秒")}{number("minSize", "最小文件", "MB")}{number("maxSize", "最大文件", "MB")}</div><button className="button subtle" onClick={clear}>重置筛选</button></section>;
}
function EntityGrid({ items, kind, open, edit, remove, create }: { items: Entity[]; kind: "tags" | "collections"; open: (entity: Entity) => void; edit: (entity: Entity) => void; remove: (entity: Entity) => void; create: () => void }) {
  if (!items.length) return <Empty icon={kind === "collections" ? <Folder size={32} strokeWidth={1.3} /> : <Tag size={32} strokeWidth={1.3} />} title={kind === "collections" ? "还没有收藏集" : "还没有标签"} description={kind === "collections" ? "把同一个游戏、角色或主题的素材放在一起。" : "用头像、壁纸、梗图等标签标记用途，同一素材可以有多个标签。"}><button className="button primary" onClick={create}><Plus size={15} />新建{kind === "collections" ? "收藏集" : "标签"}</button></Empty>;
  return <div className={`entity-grid ${kind}`}>{items.map(entity => <article className="entity-card" key={entity.id}><button className="entity-open" onClick={() => open(entity)}><div className="entity-cover">{entity.coverUrl ? <img src={entity.coverUrl} alt="" loading="lazy" /> : kind === "collections" ? <Folder size={35} strokeWidth={1.2} /> : <Tag size={30} strokeWidth={1.2} />}</div><div className="entity-card-info"><h2>{entity.name}</h2><span>{entity.count} 个素材</span></div></button><div className="entity-actions"><button className="icon-button" aria-label={`编辑 ${entity.name}`} title="编辑" onClick={() => edit(entity)}><MoreHorizontal size={17} /></button><button className="icon-button" aria-label={`移除 ${entity.name}`} title="移除" onClick={() => remove(entity)}><Trash2 size={15} /></button></div></article>)}</div>;
}
function EntityEditor({ kind, entity, scope, close, saved, remove }: { kind: "tags" | "collections"; entity?: Entity; scope: Scope; close: () => void; saved: () => void; remove?: () => void }) {
  const [name, setName] = useState(entity?.name || "");
  const [hidden, setHidden] = useState(entity?.hidden ?? scope === "hidden");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = kind === "collections" ? "收藏集" : "标签";
  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true); setError("");
    try { await api(entity ? `${kind}/${entity.id}` : kind, { name: name.trim(), hidden }, entity ? "PATCH" : "POST"); saved(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title={`${entity ? "编辑" : "新建"}${label}`} close={close}><form className="metadata-form" onSubmit={event => { event.preventDefault(); void save(); }}><label>名称<input value={name} onChange={event => setName(event.target.value)} maxLength={200} placeholder={kind === "collections" ? "例如：桌面壁纸、某款游戏" : "例如：头像、梗图"} /></label><div className="form-switches"><label><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} />隐藏此{label}</label></div><p className="form-help">隐藏后，关联的全部素材都会进入隐藏模式，即使它们同时属于其他普通{label}。</p>{error && <div className="inline-error">{error}</div>}<footer className="dialog-footer">{remove && <button type="button" className="button danger entity-delete" disabled={busy} onClick={remove}><Trash2 size={15} />删除收藏集</button>}<button type="button" className="button" onClick={close}>取消</button><button className="button primary" type="submit" disabled={!name.trim() || busy}>{busy ? <RotateCw size={15} className="spin" /> : <Check size={15} />}保存</button></footer></form></Dialog>;
}
function Organize({ ids, tags, collections, close, save }: { ids: string[]; tags: Entity[]; collections: Entity[]; close: () => void; save: (value: Patch) => Promise<void> }) {
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [action, setAction] = useState("add");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function choices(items: Entity[], selected: string[], update: (value: string[]) => void) { return <div className="choice-chips">{items.map(item => <button type="button" key={item.id} className={selected.includes(item.id) ? "selected" : ""} onClick={() => update(selected.includes(item.id) ? selected.filter(id => id !== item.id) : [...selected, item.id])}>{selected.includes(item.id) && <Check size={12} />}{item.name}</button>)}</div>; }
  async function submit() {
    if (busy || (!tagIds.length && !collectionIds.length)) return;
    setBusy(true); setError("");
    const value: Patch = {};
    if (action === "add") { value.addTagIds = tagIds; value.addCollectionIds = collectionIds; }
    else { value.removeTagIds = tagIds; value.removeCollectionIds = collectionIds; }
    try { await save(value); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  }
  return <Dialog title={`整理 ${ids.length} 个素材`} close={close} wide><div className="metadata-form"><div className="form-section"><label>操作<select value={action} onChange={event => setAction(event.target.value)}><option value="add">添加标签与收藏集</option><option value="remove">移除标签与收藏集</option></select></label></div><div className="form-section"><h3>标签</h3>{tags.length ? choices(tags, tagIds, setTagIds) : <p className="muted">还没有标签，可以先在标签页面创建。</p>}</div><div className="form-section"><h3>收藏集</h3>{collections.length ? choices(collections, collectionIds, setCollectionIds) : <p className="muted">还没有收藏集，可以先在收藏集页面创建。</p>}</div><p className="form-help">素材只要有一个标签或收藏集就算已整理，移除全部关联后会自动回到未整理。</p>{error && <div className="inline-error">{error}</div>}<footer className="dialog-footer"><button className="button" onClick={close}>取消</button><button className="button primary" onClick={() => void submit()} disabled={busy || (!tagIds.length && !collectionIds.length)}>{busy ? <RotateCw size={15} className="spin" /> : <Check size={15} />}应用</button></footer></div></Dialog>;
}
function Purge({ count, close, confirm }: { count: number; close: () => void; confirm: () => Promise<void> }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog title="永久删除素材" close={close}><div className="confirm-content"><div className="danger-icon"><Trash2 size={27} /></div><p>将永久删除选中的 <strong>{count}</strong> 个素材及其原件，不能从回收站恢复。</p><p className="muted">不会影响其他素材或已有备份。</p><label className="confirm-check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />我确认永久删除这些原件</label>{error && <div className="inline-error">{error}</div>}</div><footer className="dialog-footer"><button className="button" onClick={close}>取消</button><button className="button danger filled" disabled={!checked || busy} onClick={async () => { setBusy(true); try { await confirm(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); } }}>{busy ? <RotateCw size={15} className="spin" /> : <Trash2 size={15} />}永久删除</button></footer></Dialog>;
}
function RemoveEntity({ kind, entity, close, confirm }: { kind: "tags" | "collections"; entity: Entity; close: () => void; confirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog title={kind === "tags" ? "移除标签" : "删除收藏集"} close={close}><div className="confirm-content"><p>{kind === "tags" ? "移除" : "删除"}“{entity.name}”及其关联{kind === "collections" ? "、内部的分组" : ""}，不会删除任何素材原件。</p>{entity.hidden && <p className="muted">仅通过它继承隐藏的素材，将恢复为普通模式可见。</p>}{error && <div className="inline-error">{error}</div>}</div><footer className="dialog-footer"><button className="button" onClick={close}>取消</button><button className="button danger" disabled={busy} onClick={async () => { setBusy(true); try { await confirm(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); } }}>{kind === "tags" ? "确认移除" : "确认删除"}</button></footer></Dialog>;
}
function Jobs({ items, retry, open }: { items: Job[]; retry: (ids: string[]) => Promise<void>; open: (id: string) => Promise<void> }) {
  const [filter, setFilter] = useState("all");
  const filtered = items.filter(item => filter === "all" || (filter === "active" ? ["queued", "processing", "deleting"].includes(item.status) : item.status === filter));
  const failed = items.filter(item => item.status === "error");
  return <><div className="jobs-toolbar"><div className="kind-tabs">{[["all", "全部"], ["active", "进行中"], ["ready", "已完成"], ["error", "失败"]].map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div>{!!failed.length && <button className="button" onClick={() => void retry(failed.map(item => item.assetId))}><RotateCw size={15} />重试失败项</button>}</div>{filtered.length ? <div className="jobs-list">{filtered.map(job => <div className="job-row" key={job.id}><div className={`job-status-icon ${job.status}`}>{job.thumbnailUrl ? <img src={job.thumbnailUrl} alt="" /> : job.status === "error" ? <CircleAlert size={19} /> : job.status === "ready" ? <Check size={19} /> : <RotateCw size={18} className={job.status === "processing" ? "spin" : ""} />}</div><div className="job-description"><button onClick={() => void open(job.assetId)}>{job.name}</button><div><span>{stateNames[job.status] || job.status}</span>{job.stage && <span>{job.stage}</span>}{job.engine && <span>{job.engine}</span>}{job.updatedAt && <span>{new Date(job.updatedAt).toLocaleString("zh-CN", { hour12: false })}</span>}</div>{job.error && <p>{job.error}</p>}{job.status === "processing" && job.progress > 0 && <div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div>}</div>{job.status === "error" && <button className="button subtle" onClick={() => void retry([job.assetId])}><RotateCw size={15} />重试</button>}</div>)}</div> : <Empty icon={<Layers3 size={30} strokeWidth={1.3} />} title="暂无处理任务" description="上传后，缩略图和兼容播放版本会在后台生成。" />}</>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
