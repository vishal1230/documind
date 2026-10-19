import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const base =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none " +
  "transition-[background-color,border-color,color,box-shadow] duration-150 ease-out " +
  "disabled:pointer-events-none disabled:opacity-45";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-white shadow-xs hover:bg-accent-hover active:bg-accent-hover",
  secondary: "border border-line bg-surface text-ink shadow-xs hover:border-line-strong hover:bg-canvas",
  ghost: "text-muted hover:bg-sunken hover:text-ink",
  danger: "bg-danger text-white shadow-xs hover:bg-[#912018]",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[13px]",
  md: "h-9 px-3.5 text-sm",
};

export function buttonClass(variant: Variant = "secondary", size: Size = "md") {
  return `${base} ${variants[variant]} ${sizes[size]}`;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: IconName };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, className = "", children, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={`${buttonClass(variant, size)} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 16} />}
      {children}
    </button>
  );
});

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string; // accessible name; also shown as the native tooltip
  size?: Size;
  iconSize?: number;
};

/** Square, icon-only button. Always has an accessible label. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = "md", iconSize, className = "", type = "button", ...rest },
  ref,
) {
  const box = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-45 ${box} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={iconSize ?? (size === "sm" ? 15 : 18)} />
    </button>
  );
});
