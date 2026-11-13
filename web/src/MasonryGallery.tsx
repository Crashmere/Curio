import { ReactNode, useLayoutEffect, useRef } from "react";

export type GroupFormation = { id: string; assetIds: string[] };
type Rect = { left: number; top: number; width: number; height: number };
type TileSnapshot = { rect: Rect; thumbnail?: { id: string; image: HTMLImageElement; rect: Rect } };
const motion = { duration: 360, easing: "cubic-bezier(.22, 1, .36, 1)" };
function pageRect(element: HTMLElement): Rect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left + scrollX, top: rect.top + scrollY, width: rect.width, height: rect.height };
}
function visible(rect: Rect) { return rect.top + rect.height > scrollY && rect.top < scrollY + innerHeight; }

export function MasonryGallery({ children, formation, className = "collection-gallery" }: { children: ReactNode; formation?: GroupFormation; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const snapshots = useRef(new Map<HTMLElement, TileSnapshot>());
  const lastFormation = useRef<GroupFormation>(undefined);
  const animations = useRef(new Set<Animation>());
  const ghosts = useRef(new Set<HTMLImageElement>());
  useLayoutEffect(() => () => {
    for (const animation of animations.current) animation.cancel();
    for (const ghost of ghosts.current) ghost.remove();
    animations.current.clear(); ghosts.current.clear();
  }, []);
  useLayoutEffect(() => {
    const gallery = container.current!;
    const animate = (element: HTMLElement, frames: Keyframe[], cleanup?: () => void) => {
      const animation = element.animate(frames, motion);
      animations.current.add(animation);
      const finish = () => { animations.current.delete(animation); animation.cancel(); cleanup?.(); };
      void animation.finished.then(finish, finish);
    };
    let previousWidth = 0;
    const layout = () => {
      const width = gallery.clientWidth;
      if (!width) return;
      previousWidth = width;
      const style = getComputedStyle(gallery);
      const gap = parseFloat(style.getPropertyValue("--masonry-gap")) || 14;
      const minimum = parseFloat(style.getPropertyValue("--tile-width")) || 225;
      const columns = parseInt(style.getPropertyValue("--masonry-columns")) || Math.max(1, Math.floor((width + gap) / (minimum + gap)));
      const columnWidth = (width - gap * (columns - 1)) / columns;
      const tiles = Array.from(gallery.children).filter((element): element is HTMLElement => element instanceof HTMLElement && !element.hidden);
      const widths = tiles.map(tile => tile.dataset.span === "full" ? width : columnWidth);
      tiles.forEach((tile, index) => { tile.style.width = `${widths[index]}px`; });
      // Reveal transforms must not change the dimensions used for packing.
      const heights = tiles.map(tile => tile.offsetHeight);
      const bottoms = Array<number>(columns).fill(0);
      const nextColumn = () => {
        const shortest = Math.min(...bottoms);
        // Tiny aspect-ratio differences must not scatter a nearly level partial row.
        return bottoms.findIndex(bottom => bottom <= shortest + gap);
      };
      const place = (index: number, column: number) => {
        const tile = tiles[index];
        tile.style.left = `${column * (columnWidth + gap)}px`;
        tile.style.top = `${bottoms[column]}px`;
        bottoms[column] += heights[index] + gap;
      };
      for (let index = 0; index < tiles.length; index++) {
        const tile = tiles[index];
        if (tile.dataset.span !== "full") {
          place(index, nextColumn());
          continue;
        }
        // An expanded group owns a full row; its inner gallery packs the members.
        bottoms.fill(Math.max(...bottoms));
        place(index, 0);
        bottoms.fill(bottoms[0]);
      }
      gallery.style.height = `${Math.max(0, ...bottoms) - (tiles.length ? gap : 0)}px`;
      const previous = snapshots.current;
      const next = new Map<HTMLElement, TileSnapshot>();
      for (const tile of tiles) {
        const rect = pageRect(tile);
        const card = tile.matches("[data-asset]") ? tile : tile.querySelector<HTMLElement>("[data-asset]");
        const image = card?.querySelector<HTMLImageElement>(".media-open img");
        next.set(tile, { rect, thumbnail: image?.complete && image.naturalWidth ? { id: card!.dataset.asset!, image, rect: pageRect(image) } : undefined });
      }
      snapshots.current = next;
      const forming = formation && formation !== lastFormation.current;
      lastFormation.current = formation;
      if (!forming || !previous.size || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      for (const [tile, snapshot] of next) {
        const before = previous.get(tile)?.rect;
        if (!before || (!visible(before) && !visible(snapshot.rect))) continue;
        const x = before.left - snapshot.rect.left;
        const y = before.top - snapshot.rect.top;
        if (Math.abs(x) + Math.abs(y) > 1) animate(tile, [{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }]);
      }
      const stack = tiles.find(tile => tile.classList.contains("media-group") && tile.dataset.group === formation.id);
      const cover = stack?.querySelector<HTMLImageElement>(".group-sheet:last-child img");
      if (!stack || !cover || !visible(pageRect(stack))) return;
      const target = pageRect(cover);
      // A few thumbnail-only ghosts keep large selections cheap and non-interactive.
      const selected = new Set(formation.assetIds);
      const sources = [...previous.values()].flatMap(snapshot => snapshot.thumbnail && selected.has(snapshot.thumbnail.id) && visible(snapshot.thumbnail.rect) ? [snapshot.thumbnail] : []).slice(0, 6);
      if (!sources.length) return;
      sources.forEach((source, index) => {
        const ghost = source.image.cloneNode(false) as HTMLImageElement;
        ghost.loading = "eager"; ghost.decoding = "sync";
        ghost.className = "group-formation-ghost"; ghost.alt = ""; ghost.setAttribute("aria-hidden", "true");
        Object.assign(ghost.style, { left: `${source.rect.left}px`, top: `${source.rect.top}px`, width: `${source.rect.width}px`, height: `${source.rect.height}px` });
        document.body.appendChild(ghost); ghosts.current.add(ghost);
        const transform = `translate(${target.left - source.rect.left}px, ${target.top - source.rect.top}px) scale(${target.width / source.rect.width}, ${target.height / source.rect.height}) rotate(${index % 3 * 2 - 2}deg)`;
        animate(ghost, [{ opacity: .9, transform: "none", offset: 0 }, { opacity: .65, transform, offset: .75 }, { opacity: 0, transform, offset: 1 }], () => { ghost.remove(); ghosts.current.delete(ghost); });
      });
      animate(stack, [{ opacity: .2, transform: "scale(.96)", offset: 0 }, { opacity: 1, transform: "none", offset: 1 }]);
    };
    const observer = new ResizeObserver(entries => {
      if (entries.some(entry => entry.target !== gallery || entry.contentRect.width !== previousWidth)) layout();
    });
    observer.observe(gallery);
    for (const tile of gallery.children) observer.observe(tile);
    layout();
    return () => observer.disconnect();
  }, [children, formation]);
  return <div className={`gallery masonry-gallery ${className}`} ref={container}>{children}</div>;
}
