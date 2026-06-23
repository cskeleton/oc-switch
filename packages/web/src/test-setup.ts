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
  getComputedStyle: win.getComputedStyle.bind(win)
});
