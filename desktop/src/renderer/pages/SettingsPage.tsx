import { useState } from "react";
import type { AppSettings, OutputFolderId, SettingsPatch, ThemePreference } from "../../shared/api";
import { Icon } from "../components/Icon";
import { FieldRow, Segmented, Switch } from "../components/ui";

const THEME_OPTIONS = ["System", "Light", "Dark"] as const;
type ThemeOption = (typeof THEME_OPTIONS)[number];
const OUTPUT_FOLDERS: ReadonlyArray<{ id: OutputFolderId; label: string; detail: string }> = [
    { id: "screenshots", label: "Screenshots", detail: "Lossless PNG captures" },
    { id: "recordings", label: "Recordings", detail: "Original video and audio files" },
    { id: "exports", label: "Exports", detail: "Finished MP4 and GIF files" },
];

type SettingsFeedback = {
    tone: "status" | "error";
    title: string;
    detail: string;
};

export interface SettingsPageProps {
    settings: AppSettings;
    appVersion: string;
    onUpdate: (patch: SettingsPatch) => Promise<void>;
}

function themeOption(theme: ThemePreference): ThemeOption {
    switch (theme) {
        case "light": return "Light";
        case "dark": return "Dark";
        default: return "System";
    }
}

function themePreference(option: ThemeOption): ThemePreference {
    return option.toLowerCase() as ThemePreference;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "SharpShot couldn’t save that preference.";
}

export function SettingsPage({ settings, appVersion, onUpdate }: SettingsPageProps) {
    const [pendingField, setPendingField] = useState<keyof SettingsPatch | null>(null);
    const [pendingFolder, setPendingFolder] = useState<OutputFolderId | null>(null);
    const [feedback, setFeedback] = useState<SettingsFeedback | null>(null);
    const busy = pendingField !== null || pendingFolder !== null;

    const save = async (field: keyof SettingsPatch, patch: SettingsPatch) => {
        if (busy) return;
        setPendingField(field);
        setFeedback({ tone: "status", title: "Saving…", detail: "Updating the local preference." });

        try {
            await onUpdate(patch);
            setFeedback({ tone: "status", title: "Saved locally", detail: "The preference is active on this device." });
        } catch (error) {
            setFeedback({ tone: "error", title: "Preference not saved", detail: errorMessage(error) });
        } finally {
            setPendingField(null);
        }
    };

    const revealFolder = async (folderId: OutputFolderId) => {
        if (busy) return;
        setPendingFolder(folderId);
        setFeedback({ tone: "status", title: "Opening folder…", detail: "Asking Windows to show the local output folder." });
        try {
            const result = await window.sharpShot?.folders.reveal(folderId);
            if (!result?.ok) throw new Error(result?.error.message ?? "The desktop bridge is unavailable.");
            if (!result.value) throw new Error("That folder is not available yet.");
            setFeedback({ tone: "status", title: "Folder opened", detail: "Windows Explorer is showing the selected output folder." });
        } catch (error) {
            setFeedback({ tone: "error", title: "Folder not opened", detail: errorMessage(error) });
        } finally {
            setPendingFolder(null);
        }
    };

    return (
        <div className="page settings-page">
            <header className="page-header">
                <div>
                    <h1>Settings</h1>
                    <p>Control startup, notifications, and appearance.</p>
                </div>
            </header>

            <div className="settings-layout">
                <main className="settings-content" aria-busy={busy}>
                    <section id="general" className="settings-section">
                        <header>
                            <span className="settings-section__icon"><Icon name="settings" /></span>
                            <div>
                                <h2>General</h2>
                                <p>How SharpShot behaves on Windows.</p>
                            </div>
                        </header>
                        <div className="settings-fields">
                            <FieldRow label="Launch at login" detail="Keep your global shortcuts ready after sign-in">
                                <Switch
                                    checked={settings.launchAtLogin}
                                    disabled={busy}
                                    label="Launch SharpShot at login"
                                    onChange={(value) => void save("launchAtLogin", { launchAtLogin: value })}
                                />
                            </FieldRow>
                            <FieldRow label="Keep running in tray" detail="Closing the window keeps shortcuts available">
                                <Switch
                                    checked={settings.closeToTray}
                                    disabled={busy}
                                    label="Keep SharpShot running in the tray"
                                    onChange={(value) => void save("closeToTray", { closeToTray: value })}
                                />
                            </FieldRow>
                            <FieldRow label="Result notifications" detail="Show a compact confirmation after a capture">
                                <Switch
                                    checked={settings.showNotifications}
                                    disabled={busy}
                                    label="Show result notifications"
                                    onChange={(value) => void save("showNotifications", { showNotifications: value })}
                                />
                            </FieldRow>
                        </div>
                    </section>

                    <section id="appearance" className="settings-section">
                        <header>
                            <span className="settings-section__icon"><Icon name="canvas" /></span>
                            <div>
                                <h2>Appearance</h2>
                                <p>Choose the material used throughout Studio.</p>
                            </div>
                        </header>
                        <div className="settings-fields">
                            <FieldRow label="Theme" detail="System follows the current Windows light or dark preference">
                                <Segmented<ThemeOption>
                                    disabled={busy}
                                    label="Theme"
                                    onChange={(value) => void save("theme", { theme: themePreference(value) })}
                                    options={THEME_OPTIONS}
                                    value={themeOption(settings.theme)}
                                />
                            </FieldRow>
                        </div>
                    </section>

                    <section id="output-folders" className="settings-section">
                        <header>
                            <span className="settings-section__icon"><Icon name="folder" /></span>
                            <div>
                                <h2>Output folders</h2>
                                <p>Open SharpShot’s trusted local destinations.</p>
                            </div>
                        </header>
                        <div className="settings-fields">
                            {OUTPUT_FOLDERS.map((folder) => (
                                <FieldRow detail={folder.detail} key={folder.id} label={folder.label}>
                                    <button
                                        className="button button--secondary settings-folder-button"
                                        disabled={busy}
                                        onClick={() => void revealFolder(folder.id)}
                                        type="button"
                                    >
                                        <Icon name="folder" size={14} />
                                        {pendingFolder === folder.id ? "Opening…" : "Show in folder"}
                                    </button>
                                </FieldRow>
                            ))}
                        </div>
                    </section>

                    <footer id="about" className="settings-about">
                        <span>
                            <strong>SharpShot Studio</strong>
                            <small>Version {appVersion} · Windows x64</small>
                        </span>
                        <span aria-atomic="true" role={feedback?.tone === "error" ? "alert" : "status"}>
                            <strong>{feedback?.title ?? "Stored locally"}</strong>
                            <small>{feedback?.detail ?? "Your preferences stay on this device."}</small>
                        </span>
                    </footer>
                </main>
            </div>
        </div>
    );
}
