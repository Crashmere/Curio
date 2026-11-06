import { ReactNode, useLayoutEffect, useRef } from "react";

export function MasonryGallery({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const gallery = container.current!;
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
      const widths = tiles.map(tile => columnWidth * (parseFloat(getComputedStyle(tile).getPropertyValue("--tile-scale")) || 1));
      tiles.forEach((tile, index) => { tile.style.width = `${widths[index]}px`; });
      // Reveal transforms must not change the dimensions used for packing.
      const heights = tiles.map(tile => tile.offsetHeight);
      const bottoms = Array<number>(columns).fill(0);
      tiles.forEach((tile, index) => {
        const column = bottoms.indexOf(Math.min(...bottoms));
        tile.style.left = `${column * (columnWidth + gap) + (columnWidth - widths[index]) / 2}px`;
        tile.style.top = `${bottoms[column]}px`;
        bottoms[column] += heights[index] + gap;
      });
      gallery.style.height = `${Math.max(0, ...bottoms) - (tiles.length ? gap : 0)}px`;
    };
    const observer = new ResizeObserver(entries => {
      if (entries.some(entry => entry.target !== gallery || entry.contentRect.width !== previousWidth)) layout();
    });
    observer.observe(gallery);
    for (const tile of gallery.children) observer.observe(tile);
    layout();
    return () => observer.disconnect();
  }, [children]);
  return <div className="gallery collection-gallery" ref={container}>{children}</div>;
}
