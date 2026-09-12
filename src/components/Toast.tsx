"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Tone = "success" | "error" | "info" | "warning";

type Toast = { id: number; title: string; body?: string; tone: Tone };

type ToastApi = {
  toast: (title: string, options?: { body?: string; tone?: Tone }) => void;
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const TONE_STYLES: Record<Tone, string> = {
  success: "border-emerald-500/40 bg-emerald-950/80 text-emerald-50",
  error: "border-crimson-600/50 bg-[#2a0a0a]/90 text-red-50",
  info: "border-fire-500/40 bg-[#1b1108]/90 text-fire-50",
  warning: "border-ember-500/45 bg-[#241a06]/90 text-ember-100",
};

const TONE_ICON: Record<Tone, string> = { success: "✓", error: "✕", info: "ℹ", warning: "!" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (title: string, options?: { body?: string; tone?: Tone }) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current.slice(-3), { id, title, body: options?.body, tone: options?.tone ?? "info" }]);
      setTimeout(() => remove(id), 6500);
    },
    [remove]
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (title, body) => toast(title, { body, tone: "success" }),
      error: (title, body) => toast(title, { body, tone: "error" }),
      info: (title, body) => toast(title, { body, tone: "info" }),
    }),
    [toast]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto w-full max-w-sm animate-rise rounded-xl border px-4 py-3 shadow-2xl shadow-black/50 backdrop-blur ${TONE_STYLES[t.tone]}`}
          >
            <div className="flex gap-2.5">
              <span className="mt-px font-bold opacity-90">{TONE_ICON[t.tone]}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-snug">{t.title}</p>
                {t.body ? <p className="mt-0.5 text-[0.82rem] leading-snug opacity-85">{t.body}</p> : null}
              </div>
              <button
                onClick={() => remove(t.id)}
                className="-mr-1 -mt-1 h-6 w-6 rounded-md text-lg leading-none opacity-60 transition hover:bg-white/10 hover:opacity-100"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
