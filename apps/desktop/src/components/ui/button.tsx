import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Vendored shadcn skeleton re-skinned to WeftCut's compact dark scale
// (ADR 0018): variants/sizes mirror the legacy button recipes the app
// converged on, expressed in tokens. Legacy context rules like
// `.export-actions button { … }` are deleted as call sites migrate —
// they are unlayered and would silently beat these utilities otherwise.
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 border font-normal whitespace-nowrap transition-colors select-none outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Primary CTA (导出 / 创建 / 添加): blue base, darken on hover.
        default:
          "border-primary bg-primary text-white hover:border-blue-700 hover:bg-blue-700",
        // The workhorse neutral action button.
        secondary:
          "border-border bg-secondary text-foreground hover:bg-accent",
        // Quiet bordered button for panel headers (corner notices).
        outline:
          "border-border bg-transparent text-muted-foreground hover:text-foreground",
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
        destructive:
          "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
      },
      size: {
        // 4px 10px / 12px / r4 — the dominant legacy box.
        default: "rounded-[4px] px-2.5 py-1 text-xs",
        // Same box, 11px / r3 (copy rows, key chips toolbars).
        sm: "rounded-[3px] px-2.5 py-1 text-[11px]",
        // 2px 8px / 11px / r3 — small panel-header buttons.
        xs: "rounded-[3px] px-2 py-px text-[11px]",
        // 6px 14px / 12px — dialog CTAs.
        lg: "rounded-[4px] px-3.5 py-1.5 text-xs",
        icon: "size-8 rounded-[4px]",
        "icon-sm": "size-7 rounded-[4px]",
        "icon-xs": "size-6 rounded-[3px]",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "secondary",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
