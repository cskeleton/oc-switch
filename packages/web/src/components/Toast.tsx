import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";
import { cn } from "../lib/utils";

/** 单条 toast */
interface ToastItem {
  id: number;
  kind: "success" | "error" | "warning";
  message: string;
}

/** 对外暴露的 toast API */
export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  /** 操作成功但附带提示（如删除后仍被 wildcard 覆盖） */
  warning: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** 自动消失时长 */
const AUTO_DISMISS_MS = 3500;

/** 在组件内取得 toast API；必须在 ToastProvider 内使用 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast 必须在 <ToastProvider> 内使用（请在应用根部挂载 ToastProvider）");
  }
  return ctx;
}

/** 轻量 toast 系统：右下角堆叠，成功 success / 失败 destructive，3.5s 自动消失 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastItem["kind"], message: string) => {
      const id = nextIdRef.current++;
      setToasts((prev) => [...prev, { id, kind, message }]);
      timersRef.current.set(id, setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push("success", message),
      error: (message) => push("error", message),
      warning: (message) => push("warning", message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg",
              t.kind === "success"
                ? "border-success/30 bg-card text-success"
                : t.kind === "warning"
                  ? "border-warning/30 bg-card text-warning"
                  : "border-destructive/30 bg-card text-destructive",
            )}
          >
            {t.kind === "success" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : t.kind === "warning" ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span className="flex-1 break-all text-foreground">{t.message}</span>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => dismiss(t.id)}
              className="mt-0.5 shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
