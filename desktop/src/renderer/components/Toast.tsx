import type { ToastMessage } from "../types";
import { Icon } from "./Icon";

export function Toast({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
    return (
        <div className={`toast toast--${toast.tone ?? "neutral"}`} role="status">
            <span className="toast__icon"><Icon name={toast.tone === "success" ? "check" : "info"} size={17} /></span>
            <div>
                <strong>{toast.title}</strong>
                <span>{toast.detail}</span>
            </div>
            <button aria-label="Dismiss notification" onClick={onClose} type="button"><Icon name="close" size={15} /></button>
        </div>
    );
}
