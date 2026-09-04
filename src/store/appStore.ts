// Replaces the original app's undo/redo (`snapshotState`/`restoreState`/
// `statesEqual`), which serialized the ENTIRE project via JSON.stringify on
// every tracked edit to diff against the previous full snapshot — O(project
// size) memory and CPU per keystroke as the project grew (images, captions,
// per-word positions/colors, timing).
//
// Here each edit pushes a small {path, before, after} action; undo/redo just
// replays that one field. Same UX (including voice's "undo the last two
// changes"), O(1) per step.

import { create } from "zustand";
import type { CardStyle, HookStyle, ShowcaseStyle, TextPos } from "../engine/renderer";

export interface ImageItem {
  id: string;
  mediaPath: string;
  caption: string;
  captionDuration?: number;
  capPosOverride?: TextPos;
  capTextColor?: string;
}

export interface EditorProject {
  images: ImageItem[]; // exactly 10, same constraint as the original
  hookDur: number;
  cardDur: number;
  cardStyle: CardStyle;
  showcaseStyle: ShowcaseStyle;
  hookStyle: HookStyle;
  voiceoverId?: string;
  musicId?: string;
  musicTrimStart?: number;
  musicTrimEnd?: number;
}

export interface HistoryAction {
  label: string;
  apply: (project: EditorProject) => EditorProject;
  invert: (project: EditorProject) => EditorProject;
}

interface AppState {
  project: EditorProject;
  history: HistoryAction[];
  future: HistoryAction[];
  dispatch: (action: HistoryAction) => void;
  undo: (steps?: number) => void;
  redo: (steps?: number) => void;
  setProject: (project: EditorProject) => void; // used only by template load / migration import, not tracked
}

const emptyTextPos: TextPos = { xNorm: 0.5, yNorm: 0.5, align: "center" };

const defaultProject: EditorProject = {
  images: [],
  hookDur: 0.2,
  cardDur: 2,
  cardStyle: {
    mode: "color",
    fillColor: "rgba(14,61,36,0.9)",
    textColor: "#ffffff",
    textPos: emptyTextPos,
    fontSize: 96,
  },
  showcaseStyle: {
    capPos: emptyTextPos,
    wordByWord: true,
    fontSize: 72,
    textColor: "#ffffff",
  },
  hookStyle: {
    capPos: emptyTextPos,
    wordByWord: true,
    fontSize: 72,
  },
};

export const useAppStore = create<AppState>((set, get) => ({
  project: defaultProject,
  history: [],
  future: [],

  dispatch: (action) => {
    const { project, history } = get();
    const nextProject = action.apply(project);
    set({ project: nextProject, history: [...history, action], future: [] });
  },

  undo: (steps = 1) => {
    const { project, history, future } = get();
    if (history.length === 0) return;
    let p = project;
    const undone: HistoryAction[] = [];
    const h = [...history];
    for (let i = 0; i < steps && h.length; i++) {
      const action = h.pop()!;
      p = action.invert(p);
      undone.unshift(action);
    }
    set({ project: p, history: h, future: [...undone, ...future] });
  },

  redo: (steps = 1) => {
    const { project, history, future } = get();
    if (future.length === 0) return;
    let p = project;
    const redone: HistoryAction[] = [];
    const f = [...future];
    for (let i = 0; i < steps && f.length; i++) {
      const action = f.shift()!;
      p = action.apply(p);
      redone.push(action);
    }
    set({ project: p, history: [...history, ...redone], future: f });
  },

  setProject: (project) => set({ project, history: [], future: [] }),
}));

/** Helper for the common "set one field" edit, used by both UI controls and voice commands. */
export function fieldAction<K extends keyof EditorProject>(
  label: string,
  key: K,
  value: EditorProject[K]
): HistoryAction {
  let prevValue: EditorProject[K];
  return {
    label,
    apply: (p) => {
      prevValue = p[key];
      return { ...p, [key]: value };
    },
    invert: (p) => ({ ...p, [key]: prevValue }),
  };
}
