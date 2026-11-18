import type { MouseEvent } from "react";
import { sendWindowAction } from "../bridge";
import { BrandLogo } from "./BrandLogo";
import { Icon } from "./Icon";

export function BrandMark({ size = 24 }: { size?: number }) {
    return <BrandLogo className="brand-mark" size={size} />;
}

export function handleTitlebarDoubleClick(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    sendWindowAction("maximize");
}

export function WindowControls({ onRequestClose }: { onRequestClose?: () => void }) {
    return (
        <div className="titlebar__window-controls">
            <button aria-label="Minimize window" title="Minimize" onClick={() => sendWindowAction("minimize")} type="button">
                <Icon name="minimize" size={16} />
            </button>
            <button aria-label="Maximize or restore window" title="Maximize or restore" onClick={() => sendWindowAction("maximize")} type="button">
                <Icon name="maximize" size={15} />
            </button>
            <button className="window-close" aria-label="Close window" title="Close" onClick={onRequestClose ?? (() => sendWindowAction("close"))} type="button">
                <Icon name="close" size={16} />
            </button>
        </div>
    );
}

export function TitleBar({ title, detail, onRequestClose }: { title?: string; detail?: string; onRequestClose?: () => void }) {
    const centerLabel = [title, detail].filter(Boolean).join(", ");
    return (
        <header className="titlebar" onDoubleClick={handleTitlebarDoubleClick}>
            <div className="titlebar__brand">
                <BrandMark size={30} />
                <span>SharpShot</span>
            </div>
            <div className="titlebar__center" aria-label={centerLabel || undefined}>
                {title ? <strong>{title}</strong> : null}
                {detail ? <small>{detail}</small> : null}
            </div>
            <WindowControls onRequestClose={onRequestClose} />
        </header>
    );
}
