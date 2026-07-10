import { pinyin } from "pinyin-pro";

/// Pinyin search haystacks for one display string: full pinyin ("zimu")
/// and initials ("zm"), both lowercase with no separators so a contiguous
/// query like "zimu" matches. Null when the string contains no CJK —
/// callers skip the extra haystacks entirely for Latin labels.
export interface PinyinHaystacks {
  full: string;
  initials: string;
}

const CJK_RE = /[㐀-䶿一-鿿]/;

// Content-keyed memo. Survives index rebuilds (module-level), which is
// what makes the "full rebuild every time" index strategy cheap — only
// never-seen strings pay pinyin generation. Cleared wholesale at the cap
// rather than LRU-tracked; caption corpora are far below the cap.
const cache = new Map<string, PinyinHaystacks | null>();
const CACHE_CAP = 20_000;

export function pinyinHaystacks(text: string): PinyinHaystacks | null {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let result: PinyinHaystacks | null = null;
  if (CJK_RE.test(text)) {
    const opts = { toneType: "none", type: "array", nonZh: "consecutive", v: true } as const;
    const full = pinyin(text, opts).join("").toLowerCase();
    const initials = pinyin(text, { ...opts, pattern: "first" }).join("").toLowerCase();
    result = { full, initials };
  }
  if (cache.size >= CACHE_CAP) cache.clear();
  cache.set(text, result);
  return result;
}
