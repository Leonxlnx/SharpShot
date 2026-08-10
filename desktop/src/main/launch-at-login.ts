export type LaunchAtLoginChangeResult =
  | { ok: true }
  | { ok: false; error: unknown; rollbackError?: unknown }

export async function changeLaunchAtLoginPreference(options: {
  previous: boolean
  requested: boolean
  applySystemSetting(enabled: boolean): void
  persistSetting(enabled: boolean): Promise<void>
}): Promise<LaunchAtLoginChangeResult> {
  let systemSettingApplied = false
  try {
    options.applySystemSetting(options.requested)
    systemSettingApplied = true
    await options.persistSetting(options.requested)
    return { ok: true }
  } catch (error) {
    if (!systemSettingApplied) return { ok: false, error }
    try {
      options.applySystemSetting(options.previous)
      return { ok: false, error }
    } catch (rollbackError) {
      return { ok: false, error, rollbackError }
    }
  }
}
