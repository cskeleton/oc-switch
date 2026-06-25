import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost" });

Object.assign(globalThis, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Element: win.Element,
  Node: win.Node,
  Text: win.Text,
  DocumentFragment: win.DocumentFragment,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  MutationObserver: win.MutationObserver,
  NodeFilter: win.NodeFilter,
  HTMLInputElement: win.HTMLInputElement,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id)
});
