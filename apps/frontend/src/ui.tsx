import { useEffect, useRef, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/api';

/**
 * The whole UI kit. shadcn/ui's idiom (Tailwind classes composed through `cn`,
 * props forwarded to the underlying element) without pulling in Radix — every
 * primitive here has a native HTML element that already does the job.
 */

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ground';

// ---------------------------------------------------------------------------

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'icon';
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        focusRing,
        size === 'sm' && 'px-3 py-1.5 text-sm',
        size === 'md' && 'px-4 py-2 text-sm',
        size === 'icon' && 'h-9 w-9',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent/85 shadow-sm',
        variant === 'subtle' && 'bg-surface-strong text-ink hover:bg-white/12 border border-edge',
        variant === 'ghost' && 'text-muted hover:bg-surface hover:text-ink',
        variant === 'danger' && 'bg-bad/90 text-white hover:bg-bad',
        className,
      )}
      {...rest}
    />
  );
}

export function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-[14px] border border-edge bg-surface p-5 shadow-[var(--shadow-widget)] backdrop-blur-xl',
        className,
      )}
      {...rest}
    />
  );
}

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-xl border border-edge bg-ground-soft/80 px-3 py-2 text-sm text-ink',
        'placeholder:text-muted/70 disabled:opacity-50',
        focusRing,
        className,
      )}
      {...rest}
    />
  );
}

export function Label({ className, ...rest }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-sm font-medium text-ink', className)} {...rest} />;
}

export function Select({ className, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full rounded-xl border border-edge bg-ground-soft px-3 py-2 text-sm text-ink',
        focusRing,
        className,
      )}
      {...rest}
    />
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-edge transition',
        checked ? 'bg-accent' : 'bg-white/10',
        disabled && 'cursor-not-allowed opacity-50',
        focusRing,
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white transition',
          checked ? 'translate-x-6' : 'translate-x-1',
        )}
      />
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn('h-5 w-5 animate-spin text-muted', className)}
      aria-hidden="true"
    />
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Stop the page behind the modal from scrolling under it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-[20px] border border-edge bg-ground-soft p-6 shadow-[var(--shadow-modal)] outline-none"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-4">{children}</div>
        {footer ? <div className="mt-6 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Inline error strip. Used everywhere an async action can fail (§4: never fail silently). */
export function ErrorNote({ message, className }: { message: string; className?: string }) {
  return (
    <p
      role="alert"
      className={cn(
        'rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad',
        className,
      )}
    >
      {message}
    </p>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="grid place-items-center gap-2 p-6 text-center">
      {icon ? <div className="text-muted/60">{icon}</div> : null}
      <p className="text-sm font-medium text-muted">{title}</p>
      {hint ? <p className="max-w-xs text-xs text-muted/70">{hint}</p> : null}
    </div>
  );
}
