import { Notice, PluginSettingTab, Setting, type App } from "obsidian"
import { type Account } from "./accounts/account.ts"
import { freeCheck, hasFreeCheck, liveTestOf, paidCheck, type CheckDeps, type CheckResult } from "./accounts/check.ts"
import { accountLlmConfig } from "./accounts/llm.ts"
import { addAccount, chooseLlmAccount, createAccount, isOwnSecret, removeAccount, secretIdFor } from "./accounts/manage.ts"
import { accountLabel, accountRoles, accountsFor, roleAccount } from "./accounts/roles.ts"
import { SERVICES, addressKeyOf, defaultRegion, presetOfService, serviceDef, type ServiceDef } from "./accounts/services.ts"
import { ASR_LANGUAGES, asrLanguageName, type AsrLanguage } from "./asr/language.ts"
import { providerOf } from "./asr/providers/registry.ts"
import { volcHandshake } from "./asr/providers/volc/live.ts"
import { inBackground } from "./background.ts"
import { liveIsLocal } from "./consent.ts"
import { listInputDevices } from "./audio/capture.ts"
import { isNoteLanguage, t } from "./i18n/index.ts"
import type { HttpGet, HttpPost } from "./llm/client.ts"
import { DEFAULT_MINUTES_PROMPT } from "./llm/minutes.ts"
import { curatedModels, listModels } from "./llm/models.ts"
import { DEFAULT_SUMMARY_FOCUS } from "./llm/summary.ts"
import { isTranscriptCleanup, type MeetingLiveSettings } from "./settings.ts"
import { platformText } from "./platform.ts"
import { readSecret } from "./secrets.ts"
import { textField } from "./ui/settingFields.ts"

/** What the settings page needs from the plugin: the settings and a way to save them, and the two HTTP calls checks make. */
export interface SettingsHost {
  settings: MeetingLiveSettings
  saveSettings(): Promise<void>
  get: HttpGet
  post: HttpPost
}

const OTHER_MODEL = "\u0000other"

type Status = { kind: "ok" | "failed" | "checking" | "manual" | "unchecked"; text: string }

/** What the add form holds before anything is stored. */
interface Draft {
  service: string
  region: string
  address: string
  key: string
  more: boolean
  /** The last check failed: pressing Add again adds the account anyway. */
  failed: boolean
  message: string
}

/** The models offered for the language-model account, and where they came from. */
interface ModelList {
  models: string[]
  source: "fetched" | "fallback" | "failed"
}

export class MeetingLiveSettingTab extends PluginSettingTab {
  private readonly plugin: SettingsHost
  private readonly status = new Map<string, Status>()
  private readonly modelLists = new Map<string, ModelList>()
  /** Accounts whose check is the one that may count as usage, because the service documents no free one. */
  private readonly needsTest = new Set<string>()
  private readonly open = new Set<string>()
  private globalAdvanced = false
  private modelOther = false
  /** The add form is showing; set from outside to land on it, as the card's "Add account" does. */
  addFormOpen = false
  private draft: Draft | undefined
  private privacyEl!: HTMLElement
  private accountsEl!: HTMLElement
  private rolesEl!: HTMLElement
  private advancedEl!: HTMLElement

  constructor(app: App, plugin: SettingsHost & ConstructorParameters<typeof PluginSettingTab>[1]) {
    super(app, plugin)
    this.plugin = plugin
  }

  private get s(): MeetingLiveSettings {
    return this.plugin.settings
  }

  private save(): void {
    inBackground(this.plugin.saveSettings())
  }

  private deps(): CheckDeps {
    return {
      get: this.plugin.get,
      post: this.plugin.post,
      volcHandshake,
      secrets: this.app.secretStorage,
      liveTest: (account, key) => liveTestOf(account, key, this.s),
    }
  }

  override display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.addClass("ml-settings")
    if (this.addFormOpen) this.draft ??= this.newDraft(SERVICES[0])

    this.privacyEl = containerEl.createDiv({ cls: "ml-settings-privacy" })
    new Setting(containerEl).setName(t("settings.accounts")).setHeading()
    this.accountsEl = containerEl.createDiv()
    this.rolesEl = containerEl.createDiv()
    this.renderPrivacy()
    this.renderAccounts()
    this.renderRoles()

    new Setting(containerEl).setName(t("settings.recording")).setHeading()
    textField(new Setting(containerEl).setName(t("settings.folder.name")).setDesc(t("settings.folder.desc")), this.s, "folder", () => this.save(), "Meetings")
    new Setting(containerEl)
      .setName(t("settings.noteLanguage.name"))
      .setDesc(t("settings.noteLanguage.desc"))
      .addDropdown((d) =>
        d
          .addOption("auto", t("settings.noteLanguage.auto"))
          .addOption("zh", t("settings.noteLanguage.zh"))
          .addOption("en", t("settings.noteLanguage.en"))
          .setValue(this.s.noteLanguage)
          .onChange((v) => {
            if (!isNoteLanguage(v)) return
            this.s.noteLanguage = v
            this.save()
          }),
      )
    new Setting(containerEl).setName(t("settings.device.name")).setDesc(platformText("systemAudio")).addDropdown(async (d) => {
      d.addOption("", t("settings.device.default"))
      try {
        for (const dev of await listInputDevices()) d.addOption(dev.deviceId, dev.label || t("settings.device.unnamed"))
      } catch {
        // Device labels need microphone permission; the default option still works.
      }
      d.setValue(this.s.deviceId).onChange((v) => {
        this.s.deviceId = v
        this.save()
      })
    })

    new Setting(containerEl).setName(t("settings.summary")).setHeading()
    new Setting(containerEl).setName(t("settings.auto.name")).addToggle((field) =>
      field.setValue(this.s.autoSummary).onChange((v) => {
        this.s.autoSummary = v
        this.save()
      }),
    )
    new Setting(containerEl)
      .setName(t("settings.interval.name"))
      .setDesc(t("settings.interval.desc"))
      .addSlider((s) =>
        s
          .setLimits(1, 30, 1)
          .setValue(this.s.summaryIntervalMin)
          .onChange((v) => {
            this.s.summaryIntervalMin = v
            this.save()
          }),
      )
    new Setting(containerEl)
      .setName(t("settings.cleanup.name"))
      .setDesc(t("settings.cleanup.desc"))
      .addDropdown((d) =>
        d
          .addOptions({ polish: t("settings.cleanup.polish"), names: t("settings.cleanup.names"), off: t("settings.cleanup.off") })
          .setValue(this.s.transcriptCleanup)
          .onChange((v) => {
            if (!isTranscriptCleanup(v)) return
            this.s.transcriptCleanup = v
            this.save()
          }),
      )
    this.promptSetting(containerEl, t("settings.focus.name"), t("settings.focus.desc"), "summaryFocus", DEFAULT_SUMMARY_FOCUS, 5)

    new Setting(containerEl).setName(t("settings.minutes")).setHeading()
    this.promptSetting(containerEl, t("settings.minutesPrompt.name"), t("settings.minutesPrompt.desc"), "minutesPrompt", DEFAULT_MINUTES_PROMPT, 12)

    this.advancedEl = containerEl.createDiv()
    this.renderGlobalAdvanced()
  }

  // ---------------------------------------------------------------- privacy

  private renderPrivacy(): void {
    this.privacyEl.empty()
    this.privacyEl.createEl("strong", { text: t("settings.privacy.title") })
    const live = roleAccount(this.s, "live")
    const text = !live ? t("settings.privacy.bodyAccounts") : t(liveIsLocal(this.s) ? "settings.privacy.bodyLocal" : "settings.privacy.body", accountLabel(this.s.accounts, live))
    this.privacyEl.createSpan({ text })
  }

  // ---------------------------------------------------------------- accounts

  private renderAccounts(): void {
    const el = this.accountsEl
    el.empty()
    if (this.s.accounts.length === 0 && !this.draft) el.createDiv({ cls: "setting-item-description ml-settings-note", text: t("settings.accounts.empty") })
    for (const account of this.s.accounts) this.renderAccount(el, account)
    if (this.draft) this.renderDraft(el, this.draft)
    else {
      new Setting(el)
        .setName(t("settings.accounts.add.name"))
        .setDesc(t("settings.accounts.add.desc"))
        .addButton((b) =>
          b
            .setButtonText(t("settings.accounts.add.button"))
            .setCta()
            .onClick(() => {
              this.draft = this.newDraft(SERVICES[0])
              this.renderAccounts()
            }),
        )
    }
  }

  private roleNames(account: Account): string {
    const can = accountRoles(account)
    return (["live", "file", "llm"] as const)
      .filter((role) => can[role])
      .map((role) => t(`settings.role.${role}`))
      .join(t("settings.role.and"))
  }

  private renderAccount(parent: HTMLElement, account: Account): void {
    const status = this.status.get(account.id)
    const roles = this.roleNames(account)
    const line = serviceDef(account.service)?.summary?.()
    const setting = new Setting(parent).setName(accountLabel(this.s.accounts, account))
    setting.descEl.createDiv({ text: line ?? (roles ? t("settings.account.serves", roles) : t("settings.account.servesNothing")) })
    const paid = this.needsTest.has(account.id) || !hasFreeCheck(account)
    // A service with no free check says so at once, rather than offering a Check that cannot tell anything.
    const shown: Status = status ?? (paid ? { kind: "manual", text: t("settings.status.manual") } : { kind: "unchecked", text: t("settings.status.unchecked") })
    setting.descEl.createDiv({ cls: `ml-account-status is-${shown.kind}`, text: shown.text })
    setting
      .addButton((b) =>
        b
          .setButtonText(paid ? t("settings.test.manual") : t("settings.check"))
          .setDisabled(status?.kind === "checking")
          .onClick(() => inBackground(this.check(account, paid))),
      )
      .addExtraButton((b) =>
        b
          .setIcon("settings")
          .setTooltip(t("settings.account.advanced"))
          .onClick(() => {
            if (!this.open.delete(account.id)) this.open.add(account.id)
            this.renderAccounts()
          }),
      )
      .addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip(t("settings.remove"))
          .onClick(() => this.remove(account)),
      )
    if (this.open.has(account.id)) this.renderAccountAdvanced(parent.createDiv({ cls: "ml-advanced" }), account)
  }

  /** Checks an account's key: the free call where the service documents one, or the Test that may count as usage when asked for it. */
  private async check(account: Account, paid: boolean): Promise<void> {
    this.status.set(account.id, { kind: "checking", text: t("settings.status.checking") })
    this.renderAccounts()
    const key = readSecret(this.app.secretStorage, account.apiKeySecret)
    const model = this.s.roles.llm.account === account.id ? this.s.roles.llm.model : undefined
    const result = paid ? await paidCheck(account, key, this.deps(), model) : await freeCheck(account, key, this.deps())
    this.applyResult(account, result)
    this.renderAccounts()
    this.renderRoles()
  }

  private applyResult(account: Account, result: CheckResult): void {
    if (result.state === "manual") {
      this.needsTest.add(account.id)
      this.status.set(account.id, { kind: "manual", text: t("settings.status.manual") })
      return
    }
    if (result.state === "failed") {
      this.status.set(account.id, { kind: "failed", text: t("settings.status.failed", result.message) })
      return
    }
    this.needsTest.delete(account.id)
    if (result.options) {
      Object.assign(account.options, result.options)
      this.save()
    }
    if (result.models?.length) this.takeModels(account, result.models)
    this.status.set(account.id, { kind: "ok", text: result.models?.length ? t("settings.status.models", result.models.length) : (result.note ?? t("settings.status.ok")) })
  }

  /** Keeps the list a service gave. A service with no suggested model (Custom, OpenRouter) leaves the model empty, so the first listed one fills it in. */
  private takeModels(account: Account, models: string[]): void {
    this.modelLists.set(account.id, { models, source: "fetched" })
    if (this.s.roles.llm.account === account.id && !this.s.roles.llm.model) {
      this.s.roles.llm.model = models[0]
      this.save()
    }
  }

  private remove(account: Account): void {
    const label = accountLabel(this.s.accounts, account)
    removeAccount(this.s, account.id)
    // A key the plugin stored is cleared with its account. One the user named (the ones 1.0.1 read) stays: 1.0.1 and other plugins may still use it.
    const shared = this.s.accounts.some((a) => a.apiKeySecret === account.apiKeySecret)
    if (isOwnSecret(account.apiKeySecret) && !shared) this.app.secretStorage.setSecret(account.apiKeySecret, "")
    this.status.delete(account.id)
    this.modelLists.delete(account.id)
    this.needsTest.delete(account.id)
    this.open.delete(account.id)
    this.save()
    new Notice(t("settings.removed", label))
    this.renderPrivacy()
    this.renderAccounts()
    this.renderRoles()
  }

  // ---------------------------------------------------------------- the add form

  private newDraft(def: ServiceDef): Draft {
    const region = defaultRegion(def)
    const key = addressKeyOf(def)
    return { service: def.id, region, address: key && def.address === "prefilled" ? String(def.options(region)[key] ?? "") : "", key: "", more: false, failed: false, message: "" }
  }

  private renderDraft(parent: HTMLElement, draft: Draft): void {
    const def = serviceDef(draft.service)!
    const box = parent.createDiv({ cls: "ml-add-form" })
    let submit: { setButtonText(text: string): unknown } | undefined
    let message: HTMLElement | undefined
    // Any edit makes the last check stale: the button goes back to Add and the old message goes away, without drawing the form again under the cursor.
    const changed = () => {
      draft.failed = false
      draft.message = ""
      submit?.setButtonText(t("settings.add.submit"))
      message?.setText("")
    }
    new Setting(box).setName(t("settings.add.service")).addDropdown((d) => {
      for (const service of SERVICES) d.addOption(service.id, service.name)
      d.setValue(draft.service).onChange((id) => {
        const next = serviceDef(id)
        if (!next) return
        this.draft = { ...this.newDraft(next), key: draft.key }
        this.renderAccounts()
      })
    })
    if (def.regions) {
      const regions = def.regions
      new Setting(box)
        .setName(t("settings.add.region"))
        .setDesc(t("settings.add.region.desc"))
        .addDropdown((d) => {
          for (const region of regions) d.addOption(region.id, region.label)
          d.setValue(draft.region).onChange((v) => {
            draft.region = v
            changed()
            // The key page and the default address belong to the region, so the form is drawn again.
            this.renderAccounts()
          })
        })
    }
    const addressKey = addressKeyOf(def)
    if (addressKey && (def.address || draft.more)) this.draftAddress(box, def, draft, changed)
    if (!def.keyless || def.presets) {
      const setting = new Setting(box).setName(t("settings.add.key"))
      setting.descEl.setText(def.keyless ? t("settings.add.key.optional") : "")
      const url = def.keyUrl(draft.region)
      if (url) setting.descEl.createEl("a", { text: t("settings.add.key.get"), href: url })
      setting.addText((field) => {
        field.inputEl.type = "password"
        field.setPlaceholder(t("settings.add.key.placeholder")).setValue(draft.key).onChange((v) => {
          draft.key = v.trim()
          changed()
        })
      })
    } else box.createDiv({ cls: "setting-item-description ml-settings-note", text: t("settings.add.key.none") })
    message = box.createDiv({ cls: `ml-add-message${draft.failed ? " is-failed" : ""}`, text: draft.message })
    const messageEl = message
    new Setting(box)
      .addButton((b) => {
        submit = b
        b.setButtonText(draft.failed ? t("settings.add.anyway") : t("settings.add.submit")).setCta().onClick(() => inBackground(this.submitDraft(draft, messageEl)))
      })
      .addButton((b) =>
        b.setButtonText(t("settings.add.cancel")).onClick(() => {
          this.draft = undefined
          this.addFormOpen = false
          this.renderAccounts()
        }),
      )
      .addExtraButton((b) =>
        b
          .setIcon("settings")
          .setTooltip(t("settings.add.more"))
          .onClick(() => {
            draft.more = !draft.more
            this.renderAccounts()
          }),
      )
  }

  private draftAddress(box: HTMLElement, def: ServiceDef, draft: Draft, changed: () => void): void {
    new Setting(box)
      .setName(t("settings.add.address"))
      .setDesc(def.address === "required" ? t("settings.add.address.required") : def.address === "prefilled" ? t("settings.add.address.prefilled") : t("settings.address.other"))
      .addText((field) => {
        const key = addressKeyOf(def)!
        field.setPlaceholder(String(def.options(draft.region)[key] ?? "")).setValue(draft.address).onChange((v) => {
          draft.address = v.trim()
          changed()
        })
      })
  }

  /** Checks what was typed before storing anything: a key that fails is not saved unless the user adds the account anyway. */
  private async submitDraft(draft: Draft, message: HTMLElement): Promise<void> {
    const def = serviceDef(draft.service)!
    const addressKey = addressKeyOf(def)
    if (!def.keyless && !draft.key) return this.say(draft, message, t("settings.add.needKey"))
    if (def.address === "required" && !draft.address) return this.say(draft, message, t("settings.add.needAddress"))
    const options = addressKey && draft.address ? { [addressKey]: draft.address } : {}
    const account = createAccount(this.s.accounts, def, draft.region, { options })
    this.say(draft, message, t("settings.add.checking"), false)
    // Pressing Add again after a failed check adds the account as it is, unchecked.
    const forced = draft.failed
    const result: CheckResult = forced ? { state: "manual" } : await freeCheck(account, draft.key, this.deps())
    if (result.state === "failed") {
      // Drawn again so the button now reads "Add anyway" and the message stays with the form.
      draft.failed = true
      draft.message = result.message
      return this.renderAccounts()
    }
    if (draft.key || !def.keyless) {
      account.apiKeySecret = secretIdFor(account.id)
      this.app.secretStorage.setSecret(account.apiKeySecret, draft.key)
    }
    addAccount(this.s, account)
    // A forced add was never checked, so it says so rather than claiming a pass.
    if (forced) this.status.set(account.id, { kind: "failed", text: t("settings.status.unchecked") })
    else this.applyResult(account, result)
    this.draft = undefined
    this.addFormOpen = false
    this.save()
    new Notice(t("settings.add.done", accountLabel(this.s.accounts, account)))
    this.renderPrivacy()
    this.renderAccounts()
    this.renderRoles()
  }

  private say(draft: Draft, el: HTMLElement, text: string, problem = true): void {
    draft.message = text
    el.setText(text)
    el.toggleClass("is-failed", problem)
  }

  // ---------------------------------------------------------------- one account's advanced settings

  private renderAccountAdvanced(el: HTMLElement, account: Account): void {
    const def = serviceDef(account.service)
    if (!def) return
    const save = () => this.save()
    textField(new Setting(el).setName(t("settings.account.name")).setDesc(t("settings.account.name.desc")), account, "name", () => {
      save()
      this.renderRoles()
    }, serviceDef(account.service)?.name ?? "")
    if (!def.keyless || def.presets) this.keyReplaceField(el, account)
    const addressKey = addressKeyOf(def)
    if (addressKey) textField(new Setting(el).setName(t("settings.account.address")).setDesc(def.presets ? t("settings.account.address.desc") : t("settings.address.other")), account.options, addressKey, save, String(def.options("")[addressKey] ?? ""))
    providerOf(account)?.renderAdvanced({ app: this.app, containerEl: el, account, save, refresh: () => this.renderAccounts() })
    const preset = presetOfService(def, account.options)
    if (preset) this.llmAdvanced(el, account, preset)
  }

  private keyReplaceField(el: HTMLElement, account: Account): void {
    new Setting(el)
      .setName(t("settings.account.key"))
      .setDesc(t("settings.account.key.desc"))
      .addText((field) => {
        field.inputEl.type = "password"
        field.setPlaceholder(account.apiKeySecret ? t("settings.account.key.saved") : t("settings.add.key.placeholder"))
        // Committed when the field loses focus, not per keystroke: each commit replaces the stored key.
        field.inputEl.addEventListener("change", () => {
          const key = field.inputEl.value.trim()
          if (!key) return
          // The secret the user named stays as it was, since 1.0.1 may still read it; the new key goes under an id of the plugin's own.
          if (!isOwnSecret(account.apiKeySecret)) account.apiKeySecret = secretIdFor(account.id)
          this.app.secretStorage.setSecret(account.apiKeySecret, key)
          field.inputEl.value = ""
          this.save()
          inBackground(this.check(account, false))
        })
      })
  }

  private llmAdvanced(el: HTMLElement, account: Account, preset: NonNullable<ReturnType<typeof presetOfService>>): void {
    const llm = account.llm
    if (preset.customHeaders) {
      new Setting(el)
        .setName(t("settings.llm.headers.name"))
        .setDesc(t("settings.llm.headers.desc"))
        .addTextArea((field) => {
          field.inputEl.rows = 3
          field.setValue(llm.headers).onChange((v) => {
            llm.headers = v
            this.save()
          })
        })
    }
    if (preset.effort !== "none") {
      new Setting(el)
        .setName(t("settings.llm.effort.name"))
        .setDesc(preset.effort === "deepseek" ? t("settings.llm.effort.deepseek") : t("settings.llm.effort.plain"))
        .addDropdown((d) =>
          d
            .addOption("off", t("settings.llm.effort.off"))
            .addOption("low", t("settings.llm.effort.low"))
            .addOption("medium", t("settings.llm.effort.medium"))
            .addOption("high", t("settings.llm.effort.high"))
            .setValue(llm.effort)
            .onChange((v) => {
              llm.effort = v as Account["llm"]["effort"]
              this.save()
            }),
        )
    }
    if (preset.temperature) {
      new Setting(el)
        .setName(t("settings.llm.temperature.name"))
        .setDesc(t("settings.llm.temperature.desc"))
        .addSlider((slider) =>
          slider
            .setLimits(0, 1, 0.05)
            .setValue(llm.temperature)
            .onChange((v) => {
              llm.temperature = v
              this.save()
            }),
        )
    }
    new Setting(el)
      .setName(t("settings.llm.limit.name"))
      .setDesc(t("settings.llm.limit.desc", preset.name, preset.inputTokens.toLocaleString()))
      .addText((field) =>
        field
          .setPlaceholder(String(preset.inputTokens))
          .setValue(llm.inputLimit > 0 ? String(llm.inputLimit) : "")
          .onChange((v) => {
            const n = Math.floor(Number(v))
            llm.inputLimit = Number.isFinite(n) && n > 0 ? n : 0
            this.save()
          }),
      )
  }

  // ---------------------------------------------------------------- roles

  private renderRoles(): void {
    const el = this.rolesEl
    el.empty()
    if (this.s.accounts.length === 0) return
    new Setting(el).setName(t("settings.roles")).setHeading()
    this.roleChoice(el, "live")
    this.roleChoice(el, "file")
    this.roleChoice(el, "llm")
    const llm = roleAccount(this.s, "llm")
    if (llm) this.modelChoice(el, llm)
  }

  private roleChoice(el: HTMLElement, role: "live" | "file" | "llm"): void {
    const candidates = accountsFor(this.s.accounts, role)
    const chosen = roleAccount(this.s, role)
    const setting = new Setting(el).setName(t(`settings.roles.${role}.name`)).setDesc(candidates.length ? t(`settings.roles.${role}.desc`) : t("settings.roles.noneAvailable"))
    setting.addDropdown((d) => {
      d.addOption("", t("settings.roles.none"))
      for (const account of candidates) d.addOption(account.id, accountLabel(this.s.accounts, account))
      d.setValue(chosen?.id ?? "").onChange((id) => {
        const account = candidates.find((a) => a.id === id)
        if (role === "llm") {
          chooseLlmAccount(this.s, account)
          this.modelOther = false
          this.save()
          this.renderRoles()
          // Choosing the account is the moment the model list is asked for.
          if (account) inBackground(this.refreshModels(account))
        } else {
          this.s.roles[role] = account?.id ?? ""
          this.save()
          this.renderPrivacy()
        }
      })
    })
  }

  private modelChoice(el: HTMLElement, account: Account): void {
    const preset = presetOfService(serviceDef(account.service)!, account.options)!
    const cached = this.modelLists.get(account.id)
    const current = this.s.roles.llm.model
    const models = cached?.models ?? curatedModels(preset.id, preset.model)
    const other = this.modelOther || !models.includes(current)
    const desc = !cached ? t("settings.model.desc.fallback") : cached.source === "fetched" ? t("settings.model.desc.fetched", cached.models.length) : cached.source === "failed" ? t("settings.model.desc.failed") : t("settings.model.desc.fallback")
    const setting = new Setting(el).setName(t("settings.model.name")).setDesc(preset.id === "azure" ? t("settings.llm.model.azure") : desc)
    setting.addDropdown((d) => {
      for (const model of models) d.addOption(model, model)
      d.addOption(OTHER_MODEL, t("settings.model.other"))
      d.setValue(other ? OTHER_MODEL : current).onChange((v) => {
        this.modelOther = v === OTHER_MODEL
        if (!this.modelOther) {
          this.s.roles.llm.model = v
          this.save()
        }
        this.renderRoles()
      })
    })
    if (other) {
      setting.addText((field) =>
        field.setPlaceholder(t("settings.model.other.placeholder")).setValue(current).onChange((v) => {
          this.s.roles.llm.model = v.trim()
          this.save()
        }),
      )
    }
    setting.addExtraButton((b) =>
      b
        .setIcon("refresh-cw")
        .setTooltip(t("settings.model.refresh"))
        .onClick(() => inBackground(this.refreshModels(account))),
    )
  }

  /** Asks the account's service for its models. A failed or missing list falls back to the short list, and the page says which. */
  private async refreshModels(account: Account): Promise<void> {
    const config = accountLlmConfig(account, readSecret(this.app.secretStorage, account.apiKeySecret), this.s.roles.llm.model)
    if (!config) return
    const outcome = await listModels(config.preset.id, config, this.plugin.get)
    if (outcome.state === "ok" && outcome.models.length) this.takeModels(account, outcome.models)
    else this.modelLists.set(account.id, { models: curatedModels(config.preset.id, config.preset.model), source: outcome.state === "ok" || outcome.state === "none" ? "fallback" : "failed" })
    if (outcome.state === "rejected") this.status.set(account.id, { kind: "failed", text: t("settings.status.failed", t("check.rejected", outcome.status)) })
    this.renderAccounts()
    this.renderRoles()
  }

  // ---------------------------------------------------------------- advanced, for the whole plugin

  private renderGlobalAdvanced(): void {
    const el = this.advancedEl
    el.empty()
    new Setting(el)
      .setName(t("settings.advanced"))
      .setDesc(t("settings.advanced.desc"))
      .addButton((b) =>
        b.setButtonText(this.globalAdvanced ? t("settings.advanced.hide") : t("settings.advanced.show")).onClick(() => {
          this.globalAdvanced = !this.globalAdvanced
          this.renderGlobalAdvanced()
        }),
      )
    if (!this.globalAdvanced) return
    const s = this.s
    new Setting(el)
      .setName(t("settings.format.name"))
      .setDesc(t("settings.format.desc"))
      .addDropdown((d) =>
        d
          .addOption("ogg", t("settings.format.opus"))
          .addOption("wav", t("settings.format.wav"))
          .setValue(s.audioFormat)
          .onChange((v) => {
            s.audioFormat = v as MeetingLiveSettings["audioFormat"]
            this.save()
          }),
      )
    new Setting(el)
      .setName(t("settings.voice.name"))
      .setDesc(t("settings.voice.desc"))
      .addToggle((field) =>
        field.setValue(s.voiceProcessing).onChange((v) => {
          s.voiceProcessing = v
          this.save()
        }),
      )
    const live = roleAccount(s, "live")
    const file = roleAccount(s, "file")
    const liveProvider = live && providerOf(live)?.live
    const fileProvider = file && providerOf(file)?.file
    if (live && liveProvider?.capabilities(live).hotwords) {
      new Setting(el)
        .setName(t("settings.hotwords.name"))
        .setDesc(t("settings.hotwords.desc"))
        .addTextArea((field) => {
          field.inputEl.rows = 4
          field.setValue(s.hotwords).onChange((v) => {
            s.hotwords = v
            this.save()
          })
        })
    }
    const contextFor = (live && liveProvider?.capabilities(live).context) || (file && fileProvider?.capabilities(file).context)
    if (contextFor) {
      new Setting(el)
        .setName(t("settings.meetingContext.name"))
        .setDesc(t("settings.meetingContext.desc"))
        .addTextArea((field) => {
          field.inputEl.rows = 3
          field.setPlaceholder(t("settings.meetingContext.placeholder"))
          field.setValue(s.meetingContext).onChange((v) => {
            s.meetingContext = v
            this.save()
          })
        })
    }
    new Setting(el)
      .setName(t("settings.corrections.name"))
      .setDesc(t("settings.corrections.desc"))
      .addTextArea((field) => {
        field.inputEl.rows = 4
        field.setPlaceholder(t("settings.corrections.placeholder"))
        field.setValue(s.corrections).onChange((v) => {
          s.corrections = v
          this.save()
        })
      })
    const languageFor = [live && liveProvider?.capabilities(live).language && t("asr.role.live"), file && fileProvider?.capabilities(file).language && t("asr.role.file")].filter(Boolean)
    if (languageFor.length) {
      new Setting(el)
        .setName(t("settings.language.name"))
        .setDesc(t("settings.language.desc", languageFor.join(t("settings.language.and"))))
        .addDropdown((d) => {
          for (const id of ASR_LANGUAGES) d.addOption(id, asrLanguageName(id))
          d.setValue(s.asrLanguage).onChange((v) => {
            s.asrLanguage = v as AsrLanguage
            this.save()
          })
        })
    }
  }

  private promptSetting(el: HTMLElement, name: string, desc: string, key: "summaryFocus" | "minutesPrompt", fallback: string, rows: number): void {
    const setting = new Setting(el).setName(name).setDesc(desc)
    setting.settingEl.addClass("ml-prompt-setting")
    let area: HTMLTextAreaElement
    setting.addExtraButton((b) =>
      b
        .setIcon("rotate-ccw")
        .setTooltip(t("settings.resetDefault"))
        .onClick(() => {
          this.s[key] = fallback
          area.value = fallback
          this.save()
        }),
    )
    setting.addTextArea((field) => {
      area = field.inputEl
      field.inputEl.rows = rows
      field.setValue(this.s[key]).onChange((v) => {
        this.s[key] = v
        this.save()
      })
    })
  }
}
