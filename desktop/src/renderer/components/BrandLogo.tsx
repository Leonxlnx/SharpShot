import studioLogo from "../../../resources/icons/sharpshot-studio-preview.png";

export function BrandLogo({ className, size = 30 }: { className?: string; size?: number }) {
    return (
        <img
            alt=""
            aria-hidden="true"
            className={className}
            decoding="sync"
            draggable={false}
            height={size}
            src={studioLogo}
            width={size}
        />
    );
}
