import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CornerNoticeProps {
  title: ReactNode;
  /// The header's single action — always a dismiss-shaped button today.
  actionLabel: ReactNode;
  onAction: () => void;
  actionDisabled?: boolean;
  /// Extra panel classes on top of the shared corner chrome
  /// ("motif-stale-dialog" etc.).
  className?: string;
  children: ReactNode;
}

/// Non-modal corner notice panel (motif staleness). Deliberately NOT an
/// AppDialog: these inform without blocking — no backdrop, no focus trap, no
/// Escape close. The legacy `.export-panel.import-proxy-dialog` chrome stays
/// the shared skin.
///
/// Import-optimize progress used to live here too; it now rides the Media Pool
/// cards as badges, because a corner panel occludes the editor for state the
/// user does not have to act on.
export function CornerNotice({
  title,
  actionLabel,
  onAction,
  actionDisabled,
  className,
  children,
}: CornerNoticeProps) {
  return (
    <aside
      className={cn("export-panel import-proxy-dialog", className)}
      role="status"
    >
      <header>
        <span>{title}</span>
        <Button variant="outline" size="xs" disabled={actionDisabled} onClick={onAction}>
          {actionLabel}
        </Button>
      </header>
      {children}
    </aside>
  );
}
