// Direct, faithful port of the original app's voice-sync pipeline
// (transcribeWithGroq / syncNormWord / syncLevenshtein / syncWordsMatch /
// syncAlignCaption / globalAlignScript — hook_showcase (2).html lines
// ~2136-2290). This is pure logic with no DOM/IndexedDB dependency in the
// original either, so it ports essentially unchanged — the value of the
// migration here is *only* that it now runs the same as everywhere else in
// a normal typed module instead of inline globals, not a rewrite of the
// algorithm itself. Nothing about matching quality should change.

export interface GroqWord {
  word: string;
  start: number;
  end: number;
}

export interface GroqTranscription {
  text: string;
  words: GroqWord[];
}

export async function transcribeWithGroq(file: Blob, apiKey: string): Promise<GroqTranscription> {
  const form = new FormData();
  form.append("file", file);
  form.append("model", "whisper-large-v3");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Groq error ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

export function syncNormWord(w: string): string {
  return (w || "").toLowerCase().replace(/[^a-z0-9']/g, "");
}

export function syncLevenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

export function syncWordsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (a.length > 3 && b.length > 3 && syncLevenshtein(a, b) <= 1) return true;
  return false;
}

/** Local per-caption alignment — kept as the pass-1.5 single-caption fallback, same as the original. */
export function syncAlignCaption(capTokens: string[], words: GroqWord[], startAt: number): number[] | null {
  const SKIP_BUDGET = 60;
  const CONTINUATION_SKIP_BUDGET = 6;
  let p = startAt;
  const matchedIdxs: number[] = [];
  for (const tok of capTokens) {
    const budget = matchedIdxs.length === 0 ? SKIP_BUDGET : CONTINUATION_SKIP_BUDGET;
    const limit = Math.min(words.length, p + budget);
    let found = -1;
    for (let k = p; k < limit; k++) {
      const w = syncNormWord(words[k].word);
      const isMatch = matchedIdxs.length === 0 ? tok === w : syncWordsMatch(tok, w);
      if (isMatch) {
        found = k;
        break;
      }
    }
    if (found === -1) continue;
    matchedIdxs.push(found);
    p = found + 1;
  }
  const minNeeded = Math.max(1, Math.ceil(capTokens.length * 0.34));
  if (matchedIdxs.length < minNeeded) return null;
  return matchedIdxs;
}

export interface AlignUnit {
  owner: string;
  toks: string[];
}

/**
 * Global forced alignment (Needleman-Wunsch style) across the whole script vs.
 * the whole transcript in one monotonic pass — prevents a fuzzy match on one
 * caption from "jumping ahead" onto a later, unrelated word (the exact bug
 * class documented in the original source comments: an early false anchor
 * dragging every following caption's timing forward with it).
 */
export function globalAlignScript(units: AlignUnit[], words: GroqWord[]): (number[] | null)[] {
  const S: { tok: string; ui: number; ti: number }[] = [];
  units.forEach((u, ui) => u.toks.forEach((tok, ti) => S.push({ tok, ui, ti })));
  const W = words.map((w) => syncNormWord(w.word));
  const K = S.length,
    M = W.length;
  if (!K || !M) return units.map(() => null);

  const NEG = -1e9;
  const GAP_S = 0.6;
  const GAP_W = 0.15;
  const matchScore = (a: string, b: string) => (a === b ? 3 : syncWordsMatch(a, b) ? 1 : NEG);

  const DIAG = 0,
    UP = 1,
    LEFT = 2;
  const bp = new Uint8Array((K + 1) * (M + 1));
  let prev = new Float64Array(M + 1);
  for (let j = 1; j <= M; j++) {
    prev[j] = -j * GAP_W;
    bp[j] = LEFT;
  }
  for (let i = 1; i <= K; i++) {
    const cur = new Float64Array(M + 1);
    cur[0] = -i * GAP_S;
    bp[i * (M + 1)] = UP;
    const tok = S[i - 1].tok;
    for (let j = 1; j <= M; j++) {
      const diagScore = matchScore(tok, W[j - 1]);
      const diag = diagScore > NEG / 2 ? prev[j - 1] + diagScore : NEG;
      const up = prev[j] - GAP_S;
      const left = cur[j - 1] - GAP_W;
      let best = diag,
        dir = DIAG;
      if (up > best) {
        best = up;
        dir = UP;
      }
      if (left > best) {
        best = left;
        dir = LEFT;
      }
      cur[j] = best;
      bp[i * (M + 1) + j] = dir;
    }
    prev = cur;
  }

  const perUnit: number[][] = units.map(() => []);
  let i = K,
    j = M;
  while (i > 0 || j > 0) {
    const dir = i > 0 && j > 0 ? bp[i * (M + 1) + j] : i > 0 ? UP : LEFT;
    if (dir === DIAG) {
      const s = S[i - 1];
      if (matchScore(s.tok, W[j - 1]) > NEG / 2) perUnit[s.ui].push(j - 1);
      i--;
      j--;
    } else if (dir === UP) {
      i--;
    } else {
      j--;
    }
  }
  return perUnit.map((idxs) => (idxs.length ? idxs.sort((a, b) => a - b) : null));
}
