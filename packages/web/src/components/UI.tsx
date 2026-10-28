import { CheckCircle2, X } from "lucide-react";

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "violet" | "green" | "amber" | "red" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="toast" role="status">
      <CheckCircle2 size={17} aria-hidden="true" />
      <span>{message}</span>
      <button onClick={onClose} aria-label="关闭提示"><X size={15} /></button>
    </div>
  );
}

export function EmptyState({ icon, title, detail, action }: { icon: React.ReactNode; title: string; detail: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{detail}</p>{action}</div>;
}
