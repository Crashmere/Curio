// The server supplies per-character readings, separated by spaces and alternate readings by '/'.
export function searchScore(text: string, pinyin: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const lower = text.toLowerCase();
  const index = lower.indexOf(q);
  if (index >= 0) return index === 0 ? 4 : 3;
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length > 1 && terms.every(term => lower.includes(term))) return 3;
  const letters = q.replace(/[\s']+/g, "");
  if (!/^[a-z0-9]+$/.test(letters)) return 0;
  const units = pinyin.split(" ").filter(Boolean).map(unit => unit.split("/"));
  const failed = new Set<number>();
  // A character accepts a full syllable or any prefix, allowing initials and mixed input.
  const from = (unit: number, position: number): boolean => {
    if (position === letters.length) return true;
    const key = unit * (letters.length + 1) + position;
    if (unit === units.length || failed.has(key)) return false;
    for (const reading of units[unit]) {
      let length = 0;
      while (length < reading.length && reading[length] === letters[position + length]) length++;
      for (let take = length; take > 0; take--) if (from(unit + 1, position + take)) return true;
    }
    failed.add(key);
    return false;
  };
  for (let start = 0; start < units.length; start++) if (from(start, 0)) return start === 0 ? 2 : 1;
  return 0;
}
