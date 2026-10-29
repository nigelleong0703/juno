import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-focus-ring focus-visible:ring-[3px] focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed data-[state=open]:bg-primary-hover aria-pressed:bg-primary-hover",
        // Legacy product aliases (ARCHITECTURE §5.1) — map onto shadcn's defaults.
        primary:
          "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed data-[state=open]:bg-primary-hover aria-pressed:bg-primary-hover",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 active:bg-destructive/80 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        danger:
          "bg-destructive text-white hover:bg-destructive/90 active:bg-destructive/80 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-input bg-background shadow-xs hover:bg-interactive-hover hover:text-accent-foreground active:bg-interactive-pressed data-[state=open]:bg-interactive-selected data-[state=open]:text-accent-foreground aria-pressed:bg-interactive-selected aria-pressed:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-interactive-hover active:bg-interactive-pressed data-[state=open]:bg-interactive-selected aria-pressed:bg-interactive-selected",
        ghost:
          "hover:bg-interactive-hover hover:text-accent-foreground active:bg-interactive-pressed data-[state=open]:bg-interactive-selected data-[state=open]:text-accent-foreground aria-pressed:bg-interactive-selected aria-pressed:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 px-2.5 text-xs has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        // Legacy alias for the old `md` (same as shadcn `sm`).
        md: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
