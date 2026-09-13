import { Window } from "happy-dom";
import { getQueriesForElement, queries, screen } from "@testing-library/react";

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
  // Radix Switch 位于 <form> 内时会渲染依赖 ResizeObserver 的隐藏 bubble input
  ResizeObserver: win.ResizeObserver,
  NodeFilter: win.NodeFilter,
  HTMLInputElement: win.HTMLInputElement,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id)
});

// bun test 会在本文件注入 document 之前就完成 @testing-library 模块求值，
// 其 screen 在模块加载期一次性绑定 document.body，错过绑定后只剩抛错桩。
// 注入 document 后重建 screen 的查询绑定，保证任何测试文件独立运行时 screen.* 可用。
Object.assign(screen, getQueriesForElement(win.document.body as unknown as HTMLElement, queries));
