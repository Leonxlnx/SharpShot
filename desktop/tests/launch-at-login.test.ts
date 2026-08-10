import { describe, expect, it, vi } from "vitest"
import { changeLaunchAtLoginPreference } from "../src/main/launch-at-login.js"

describe("launch-at-login transaction", () => {
  it("applies the Windows state before committing the durable preference", async () => {
    const operations: string[] = []

    const result = await changeLaunchAtLoginPreference({
      previous: false,
      requested: true,
      applySystemSetting: (enabled) => { operations.push(`apply:${enabled}`) },
      persistSetting: async (enabled) => { operations.push(`persist:${enabled}`) },
    })

    expect(result).toEqual({ ok: true })
    expect(operations).toEqual(["apply:true", "persist:true"])
  })

  it("does not persist when Windows rejects the requested startup state", async () => {
    const failure = new Error("setter failed")
    const applySystemSetting = vi.fn(() => { throw failure })
    const persistSetting = vi.fn(async () => undefined)

    const result = await changeLaunchAtLoginPreference({
      previous: false,
      requested: true,
      applySystemSetting,
      persistSetting,
    })

    expect(result).toEqual({ ok: false, error: failure })
    expect(applySystemSetting).toHaveBeenCalledTimes(1)
    expect(applySystemSetting).toHaveBeenCalledWith(true)
    expect(persistSetting).not.toHaveBeenCalled()
  })

  it("restores the prior Windows state if durable persistence fails", async () => {
    const failure = new Error("disk full")
    const applySystemSetting = vi.fn()
    const persistSetting = vi.fn(async () => { throw failure })

    const result = await changeLaunchAtLoginPreference({
      previous: false,
      requested: true,
      applySystemSetting,
      persistSetting,
    })

    expect(result).toEqual({ ok: false, error: failure })
    expect(applySystemSetting.mock.calls).toEqual([[true], [false]])
    expect(persistSetting).toHaveBeenCalledWith(true)
  })

  it("reports a failed best-effort rollback without rejecting its own promise", async () => {
    const persistenceFailure = new Error("disk full")
    const rollbackFailure = new Error("rollback failed")
    const applySystemSetting = vi.fn((enabled: boolean) => {
      if (!enabled) throw rollbackFailure
    })

    const result = await changeLaunchAtLoginPreference({
      previous: false,
      requested: true,
      applySystemSetting,
      persistSetting: async () => { throw persistenceFailure },
    })

    expect(result).toEqual({
      ok: false,
      error: persistenceFailure,
      rollbackError: rollbackFailure,
    })
    expect(applySystemSetting.mock.calls).toEqual([[true], [false]])
  })
})
