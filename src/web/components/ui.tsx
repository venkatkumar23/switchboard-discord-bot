import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { JobStatus, Priority, ReportStatus } from "../../shared/types";
import { JOB_STATUS_META, PRIORITY_META, REPORT_STATUS_META } from "../lib/format";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="inline">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
  bodyless = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyless?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="inline">{actions}</div>}
        </div>
      )}
      {bodyless ? children : <div className="card-body">{children}</div>}
    </section>
  );
}

/** A colored dot always travels with its label: color is never the only signal. */
export function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="badge">
      <i className="dot" style={{ ["--dot" as string]: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

export const PriorityBadge = ({ priority }: { priority: Priority | null }) =>
  priority ? <Dot color={PRIORITY_META[priority].color} label={PRIORITY_META[priority].label} /> : <Dot color="var(--neutral-dot)" label="Triaging" />;

export const StatusBadge = ({ status }: { status: ReportStatus }) => (
  <Dot color={REPORT_STATUS_META[status].color} label={REPORT_STATUS_META[status].label} />
);

export const JobBadge = ({ status }: { status: JobStatus }) => (
  <Dot color={JOB_STATUS_META[status].color} label={JOB_STATUS_META[status].label} />
);

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="toggle">
      <span className="toggle-text">
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <span className="switch">
        <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span aria-hidden="true" />
      </span>
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Banner({ kind = "info", children }: { kind?: "info" | "good" | "warn" | "error"; children: ReactNode }) {
  const icon = { info: "ℹ️", good: "✅", warn: "⚠️", error: "⛔" }[kind];
  return (
    <div className={`banner ${kind === "info" ? "" : kind}`} role={kind === "error" ? "alert" : "status"}>
      <span aria-hidden="true">{icon}</span>
      <div>{children}</div>
    </div>
  );
}

/** Two-step confirm without a browser dialog: first click arms, second click acts. */
export function ConfirmButton({ label, confirmLabel, onConfirm, className = "btn btn-sm btn-danger" }: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

// ── Toasts ───────────────────────────────────────────────────────────
interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error";
}

const ToastContext = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span aria-hidden="true">{t.kind === "ok" ? "✓" : "⚠"}</span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
