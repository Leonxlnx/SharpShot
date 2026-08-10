import type { SVGProps } from "react";

export type IconName =
    | "home" | "library" | "workflow" | "settings" | "capture" | "image" | "video" | "plus" | "minus"
    | "search" | "grid" | "list" | "more" | "copy" | "edit" | "folder" | "trash"
    | "play" | "pause" | "split" | "magnet" | "undo" | "redo" | "export" | "back"
    | "canvas" | "background" | "layout" | "cursor" | "audio" | "captions" | "annotation" | "redact"
    | "check" | "chevronDown" | "chevronRight" | "clock" | "microphone" | "monitor"
    | "close" | "minimize" | "maximize" | "duplicate" | "reveal" | "spark" | "stop"
    | "waveform" | "speed" | "crop" | "download" | "info" | "zoom" | "fit" | "fill"
    | "record" | "text" | "externalLink" | "spotlight" | "blur";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
    name: IconName;
    size?: number;
}

function Paths({ name }: { name: IconName }) {
    switch (name) {
        case "home": return <><path d="M3.5 10.2 12 3.5l8.5 6.7"/><path d="M5.5 9.2v10h13v-10M9.5 19.2v-6h5v6"/></>;
        case "library": return <><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M8.5 4v16"/></>;
        case "workflow": return <><rect x="3.5" y="4" width="6" height="6" rx="1.5"/><rect x="14.5" y="14" width="6" height="6" rx="1.5"/><path d="M9.5 7h3a3 3 0 0 1 3 3v4M13 11.5 15.5 14l2.5-2.5"/></>;
        case "settings": return <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/></>;
        case "capture": return <><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="3.5"/></>;
        case "image": return <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 3.5 3 2.5-2 5 4.5"/></>;
        case "video": return <><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/></>;
        case "plus": return <path d="M12 5v14M5 12h14"/>;
        case "minus": return <path d="M5 12h14"/>;
        case "search": return <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/></>;
        case "grid": return <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>;
        case "list": return <><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".75" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r=".75" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r=".75" fill="currentColor" stroke="none"/></>;
        case "more": return <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>;
        case "copy": return <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></>;
        case "edit": return <><path d="m14.5 5.5 4 4M5 19l3.5-.7L19 7.8a1.4 1.4 0 0 0 0-2l-.8-.8a1.4 1.4 0 0 0-2 0L5.7 15.5 5 19Z"/></>;
        case "folder": return <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z"/>;
        case "trash": return <><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>;
        case "play": return <path d="m9 6 9 6-9 6V6Z" fill="currentColor" stroke="none"/>;
        case "pause": return <><path d="M8 6v12M16 6v12"/></>;
        case "stop": return <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>;
        case "split": return <><path d="M8 4v16M16 4v16M3.5 12h17"/><circle cx="8" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.8" fill="currentColor" stroke="none"/></>;
        case "magnet": return <><path d="M6 4v9a6 6 0 0 0 12 0V4h-4v9a2 2 0 0 1-4 0V4H6Z"/><path d="M6 8h4M14 8h4"/></>;
        case "undo": return <><path d="m8 7-4 4 4 4"/><path d="M5 11h8a6 6 0 0 1 6 6"/></>;
        case "redo": return <><path d="m16 7 4 4-4 4"/><path d="M19 11h-8a6 6 0 0 0-6 6"/></>;
        case "export": return <><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7h14v-7"/></>;
        case "download": return <><path d="M12 3v12M8 11l4 4 4-4"/><path d="M5 19h14"/></>;
        case "back": return <><path d="m10 5-7 7 7 7M4 12h17"/></>;
        case "canvas": return <><path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="8" y="8" width="8" height="8" rx="1.5"/></>;
        case "background": return <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.25"/><path d="m4 17 5-5 3.5 3 2.5-2 5 4"/></>;
        case "layout": return <><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9 4v16M9 10h11"/></>;
        case "cursor": return <path d="m5 3 13 9-6 .8L9 19 5 3Z"/>;
        case "audio": return <><path d="M4 10h4l5-4v12l-5-4H4v-4Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></>;
        case "captions": return <><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10a2.5 2.5 0 1 0 0 4M18 10a2.5 2.5 0 1 0 0 4"/></>;
        case "annotation": return <><path d="m4 18 5-12 5 12M6 14h6"/><path d="M16 7h4M18 5v4M16 15h4"/></>;
        case "redact": return <><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7 10h10M7 14h7" strokeWidth="2.5"/></>;
        case "check": return <path d="m5 12 4 4 10-10"/>;
        case "chevronDown": return <path d="m6 9 6 6 6-6"/>;
        case "chevronRight": return <path d="m9 6 6 6-6 6"/>;
        case "clock": return <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>;
        case "microphone": return <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/></>;
        case "monitor": return <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M9 21h6M12 17v4"/></>;
        case "minimize": return <path d="M6 12h12"/>;
        case "maximize": return <rect x="6" y="6" width="12" height="12" rx="1"/>;
        case "close": return <path d="m7 7 10 10M17 7 7 17"/>;
        case "duplicate": return <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5H5v11h3"/></>;
        case "reveal": return <><path d="M12 5c-5.5 0-9 7-9 7s3.5 7 9 7 9-7 9-7-3.5-7-9-7Z"/><circle cx="12" cy="12" r="2.5"/></>;
        case "spark": return <path d="m12 2 1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2Z"/>;
        case "waveform": return <path d="M3 12h2l1.5-5L9 18l2-12 2 12 2.5-10 1.5 7 1-3h3"/>;
        case "speed": return <><path d="M5.6 18a8 8 0 1 1 12.8 0"/><path d="m12 13 4-4"/><circle cx="12" cy="13" r="1.5" fill="currentColor" stroke="none"/></>;
        case "crop": return <path d="M7 3v14h14M3 7h14v14"/>;
        case "info": return <><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".8" fill="currentColor" stroke="none"/></>;
        case "zoom": return <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5M7.5 10.5h6M10.5 7.5v6"/></>;
        case "fit": return <><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="m9 9-5-5M15 9l5-5M15 15l5 5M9 15l-5 5"/></>;
        case "fill": return <><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><path d="m4 4 5 5M20 4l-5 5M20 20l-5-5M4 20l5-5"/></>;
        case "record": return <circle cx="12" cy="12" r="6"/>;
        case "text": return <><path d="M5 6V4h14v2M12 4v16M9 20h6"/></>;
        case "externalLink": return <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></>;
        case "spotlight": return <><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></>;
        case "blur": return <><circle cx="9" cy="9" r="3"/><circle cx="15" cy="9" r="3"/><circle cx="9" cy="15" r="3"/><circle cx="15" cy="15" r="3"/></>;
        default: return null;
    }
}

export function Icon({ name, size = 18, className, ...props }: IconProps) {
    return (
        <svg
            aria-hidden="true"
            className={className}
            fill="none"
            height={size}
            viewBox="0 0 24 24"
            width={size}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.75"
            {...props}
        >
            <Paths name={name} />
        </svg>
    );
}
