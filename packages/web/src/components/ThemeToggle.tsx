import { Moon, Sun, Laptop } from "lucide-react";
import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      return (window.localStorage.getItem("theme") as Theme) || "system";
    }
    return "system";
  });

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    if (theme === "system") {
      const hasMatchMedia = typeof window !== "undefined" && typeof window.matchMedia === "function";
      const systemTheme = hasMatchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem("theme", theme);
    }
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const hasMatchMedia = typeof window !== "undefined" && typeof window.matchMedia === "function";
    if (!hasMatchMedia) return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e: MediaQueryListEvent) => {
      const root = window.document.documentElement;
      root.classList.remove("light", "dark");
      root.classList.add(e.matches ? "dark" : "light");
    };
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [theme]);

  return (
    <div className="fixed top-4 right-4 z-50 flex items-center gap-0.5 rounded-full border border-border bg-background/60 p-1 backdrop-blur-md shadow-sm">
      <button
        type="button"
        onClick={() => setTheme("light")}
        className={`rounded-full p-1.5 transition-colors ${theme === "light" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
        aria-label="亮色模式"
        title="亮色"
      >
        <Sun className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setTheme("dark")}
        className={`rounded-full p-1.5 transition-colors ${theme === "dark" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
        aria-label="暗色模式"
        title="暗色"
      >
        <Moon className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setTheme("system")}
        className={`rounded-full p-1.5 transition-colors ${theme === "system" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
        aria-label="系统模式"
        title="系统"
      >
        <Laptop className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
