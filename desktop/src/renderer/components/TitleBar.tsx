import type { MouseEvent } from "react";
import { sendWindowAction } from "../bridge";
import { Icon } from "./Icon";

export function BrandMark({ size = 24 }: { size?: number }) {
    return (
        <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
            <Icon name="capture" size={Math.max(16, Math.round(size * .56))} />
        </span>
    );
}

function handleTitlebarDoubleClick(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    sendWindowAction("maximize");
}

export function TitleBar({ title, detail, onRequestClose }: { title: string; detail?: string; onRequestClose?: () => void }) {
    return (
        <header className="titlebar" onDoubleClick={handleTitlebarDoubleClick}>
            <div className="titlebar__brand">
                <BrandMark size={30} />
                <span>SharpShot</span>
            </div>
            <div className="titlebar__center" aria-label={detail ? `${title}, ${detail}` : title}>
                <strong>{title}</strong>
                {detail ? <small>{detail}</small> : null}
            </div>
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
        </header>
    );
}
