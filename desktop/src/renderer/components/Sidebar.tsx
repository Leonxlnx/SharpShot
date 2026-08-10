import type { AppRoute } from "../types";
import { Icon, type IconName } from "./Icon";

const PRIMARY_ITEMS: ReadonlyArray<{
    route: Exclude<AppRoute, "editor" | "settings">;
    label: string;
    icon: IconName;
    index: string;
}> = [
    { route: "home", label: "Capture", icon: "capture", index: "01" },
    { route: "library", label: "Library", icon: "library", index: "02" },
    { route: "workflows", label: "Workflows", icon: "workflow", index: "03" },
];

interface SidebarProps {
    route: AppRoute;
    onNavigate: (route: AppRoute) => void;
}

function NavigationItem({
    active,
    icon,
    index,
    label,
    onClick,
}: {
    active: boolean;
    icon: IconName;
    index: string;
    label: string;
    onClick: () => void;
}) {
    return (
        <button
            aria-current={active ? "page" : undefined}
            aria-label={label}
            className={`sidebar__item${active ? " is-active" : ""}`}
            onClick={onClick}
            title={label}
            type="button"
        >
            <span className="sidebar__index" aria-hidden="true">{index}</span>
            <span className="sidebar__icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
            <span className="sidebar__label">{label}</span>
        </button>
    );
}

export function Sidebar({ route, onNavigate }: SidebarProps) {
    return (
        <aside className="sidebar" aria-label="Main navigation">
            <nav className="sidebar__nav">
                {PRIMARY_ITEMS.map((item) => (
                    <NavigationItem
                        active={route === item.route}
                        icon={item.icon}
                        index={item.index}
                        key={item.route}
                        label={item.label}
                        onClick={() => onNavigate(item.route)}
                    />
                ))}
            </nav>
            <nav className="sidebar__bottom" aria-label="Application settings">
                <NavigationItem
                    active={route === "settings"}
                    icon="settings"
                    index="04"
                    label="Settings"
                    onClick={() => onNavigate("settings")}
                />
            </nav>
        </aside>
    );
}
