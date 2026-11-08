import type { View } from "./api";

export type Navigation = { view: View; tagId: string; collectionId: string; gameId: string };
const views: View[] = ["inbox", "starred", "collections", "tags", "trash", "jobs", "games", "screenshots"];

export function readNavigation(pathname: string, base: string): Navigation {
  const home: Navigation = { view: "all", tagId: "", collectionId: "", gameId: "" };
  if (!pathname.startsWith(base)) return home;
  const path = pathname.slice(base.length).replace(/\/$/, "");
  const container = /^(collections|tags)\/([a-f0-9]{32})$/.exec(path);
  if (container) return { ...home, [container[1] === "collections" ? "collectionId" : "tagId"]: container[2] };
  const game = /^games\/([a-f0-9]{32}|unassigned)$/.exec(path);
  if (game) return { ...home, view: "screenshots", gameId: game[1] };
  return views.includes(path as View) ? { ...home, view: path as View } : home;
}

export function navigationPath({ view, tagId, collectionId, gameId }: Navigation, base: string): string {
  if (gameId) return `${base}games/${gameId}`;
  if (collectionId) return `${base}collections/${collectionId}`;
  if (tagId) return `${base}tags/${tagId}`;
  return view === "all" ? base : `${base}${view}`;
}
