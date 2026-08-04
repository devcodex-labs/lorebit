import type { ReactNode } from "react";

type StatusBadgeProps = {
  children: ReactNode;
  tone?: "preview" | "stable";
};

export function StatusBadge({
  children,
  tone = "preview",
}: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}
