import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { createFrameCoalescer } from "../frame-coalescer";
import { nextTabIndex } from "../tablist-navigation";

export function KeyChord({ keys, compact = false }: { keys: string[]; compact?: boolean }) {
    if (keys.length === 0) {
        return <span className="shortcut-empty">Not assigned</span>;
    }
    return (
        <span className={`key-chord${compact ? " key-chord--compact" : ""}`} aria-label={keys.join(" plus ")}>
            {keys.map((key, index) => <kbd key={`${key}-${index}`}>{key}</kbd>)}
        </span>
    );
}

export function IconButton({
    icon,
    label,
    className = "",
    ...props
}: {
    icon: IconName;
    label: string;
    className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
    return (
        <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>
            <Icon name={icon} />
        </button>
    );
}

export function Switch({ checked, disabled = false, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string }) {
    return (
        <button
            aria-checked={checked}
            aria-label={label}
            className="switch-control"
            disabled={disabled}
            onClick={() => onChange(!checked)}
            role="switch"
            type="button"
        >
            <span />
        </button>
    );
}

export function Segmented<T extends string>({
    value,
    options,
    onChange,
    label,
    disabled = false,
}: {
    value: T;
    options: readonly T[];
    onChange: (value: T) => void;
    label: string;
    disabled?: boolean;
}) {
    return (
        <div aria-disabled={disabled || undefined} className="segmented-control" role="radiogroup" aria-label={label}>
            {options.map((option, index) => (
                <button
                    aria-checked={value === option}
                    className={value === option ? "is-active" : ""}
                    disabled={disabled}
                    key={option}
                    onClick={() => onChange(option)}
                    onKeyDown={(event) => {
                        const next = nextTabIndex(event.key, index, options.length);
                        if (next === null) return;
                        event.preventDefault();
                        onChange(options[next]!);
                        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='radio']").item(next).focus();
                    }}
                    role="radio"
                    tabIndex={value === option ? 0 : -1}
                    type="button"
                >
                    {option}
                </button>
            ))}
        </div>
    );
}

export function FieldRow({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
    return (
        <div className="field-row">
            <div className="field-copy">
                <span className="field-label">{label}</span>
                {detail ? <span className="field-detail">{detail}</span> : null}
            </div>
            <div className="field-control">{children}</div>
        </div>
    );
}

export function RangeField({
    label,
    value,
    min,
    max,
    step = 1,
    suffix = "",
    onChange,
    onInteractionCancel,
    onInteractionCommit,
    onInteractionStart,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    suffix?: string;
    onChange: (value: number) => void;
    onInteractionCancel?: () => void;
    onInteractionCommit?: () => void;
    onInteractionStart?: () => void;
}) {
    return (
        <label className="range-field">
            <span className="range-field__header"><span>{label}</span><output>{value}{suffix}</output></span>
            <RangeInput
                ariaLabel={label}
                max={max}
                min={min}
                onChange={onChange}
                onInteractionCancel={onInteractionCancel}
                onInteractionCommit={onInteractionCommit}
                onInteractionStart={onInteractionStart}
                step={step}
                value={value}
            />
        </label>
    );
}

export function RangeInput({
    ariaLabel,
    value,
    min,
    max,
    step = 1,
    onChange,
    onInteractionCancel,
    onInteractionCommit,
    onInteractionStart,
}: {
    ariaLabel: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (value: number) => void;
    onInteractionCancel?: () => void;
    onInteractionCommit?: () => void;
    onInteractionStart?: () => void;
}) {
    const interactionActive = useRef(false);
    const onChangeRef = useRef(onChange);
    const onInteractionCancelRef = useRef(onInteractionCancel);
    onChangeRef.current = onChange;
    onInteractionCancelRef.current = onInteractionCancel;
    const drafts = useMemo(() => createFrameCoalescer<number>(
        (callback) => window.requestAnimationFrame(callback),
        (frame) => window.cancelAnimationFrame(frame),
        (nextValue) => onChangeRef.current(nextValue),
    ), []);
    useEffect(() => () => {
        drafts.cancel();
        if (!interactionActive.current) return;
        interactionActive.current = false;
        onInteractionCancelRef.current?.();
    }, [drafts]);
    const startInteraction = () => {
        if (interactionActive.current) return;
        interactionActive.current = true;
        onInteractionStart?.();
    };
    const commitInteraction = () => {
        if (!interactionActive.current) return;
        drafts.flush();
        interactionActive.current = false;
        onInteractionCommit?.();
    };
    const cancelInteraction = () => {
        if (!interactionActive.current) return;
        drafts.cancel();
        interactionActive.current = false;
        onInteractionCancel?.();
    };
    const changeValue = (value: number) => {
        const standalone = !interactionActive.current;
        if (standalone) startInteraction();
        if (standalone) onChange(value);
        else drafts.schedule(value);
        if (standalone) commitInteraction();
    };

    return <input
        aria-label={ariaLabel}
        max={max}
        min={min}
        onBlur={commitInteraction}
        onChange={(event) => changeValue(Number(event.currentTarget.value))}
        onKeyDown={(event) => {
            if (isRangeAdjustmentKey(event.key)) startInteraction();
        }}
        onKeyUp={(event) => {
            if (isRangeAdjustmentKey(event.key)) commitInteraction();
        }}
        onLostPointerCapture={commitInteraction}
        onPointerCancel={cancelInteraction}
        onPointerDown={startInteraction}
        onPointerUp={commitInteraction}
        step={step}
        type="range"
        value={value}
    />;
}

function isRangeAdjustmentKey(key: string): boolean {
    return key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp"
        || key === "End" || key === "Home" || key === "PageDown" || key === "PageUp";
}

export function EmptyState({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
    return (
        <div className="empty-state">
            <span className="empty-state__icon"><Icon name={icon} size={20} /></span>
            <strong>{title}</strong>
            <p>{detail}</p>
        </div>
    );
}
