import { useState, useEffect } from "react";
import { t } from "@/i18n";
import { useAccountStore } from "@/stores/accountStore";
import { getSetting, setSetting, getSecureSetting, setSecureSetting } from "@/services/db/settings";
import { PROVIDER_MODELS, DEFAULT_MODELS, API_KEY_SETTINGS, resolveModelId, type AiProvider } from "@/services/ai/types";
import { Section, SettingRow, ToggleRow } from "./shared";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { SoulEditorDialog } from "@/components/settings/SoulEditorDialog";
import { ModelPicker } from "@/components/settings/ModelPicker";


function BundleSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  const storedActiveId = useAccountStore((s) => s.activeAccountId);
  const activeAccountId = storedActiveId ?? accounts[0]?.id;
  const [rules, setRules] = useState<
    Record<string, { bundled: boolean; delivery: boolean; days: number[]; hour: number; minute: number }>
  >({});

  useEffect(() => {
    if (!activeAccountId) return;
    import("@/services/db/bundleRules").then(async ({ getBundleRules }) => {
      const dbRules = await getBundleRules(activeAccountId);
      const map: typeof rules = {};
      for (const r of dbRules) {
        let schedule = { days: [6], hour: 9, minute: 0 };
        try {
          if (r.delivery_schedule) schedule = JSON.parse(r.delivery_schedule);
        } catch {
          /* use defaults */
        }
        map[r.category] = {
          bundled: r.is_bundled === 1,
          delivery: r.delivery_enabled === 1,
          days: schedule.days,
          hour: schedule.hour,
          minute: schedule.minute,
        };
      }
      setRules(map);
    });
  }, [activeAccountId]);

  const saveRule = async (category: string, update: Partial<(typeof rules)[string]>) => {
    if (!activeAccountId) return;
    const current = rules[category] ?? { bundled: false, delivery: false, days: [6], hour: 9, minute: 0 };
    const merged = { ...current, ...update };
    setRules((prev) => ({ ...prev, [category]: merged }));
    const { setBundleRule } = await import("@/services/db/bundleRules");
    await setBundleRule(
      activeAccountId,
      category,
      merged.bundled,
      merged.delivery,
      merged.delivery ? { days: merged.days, hour: merged.hour, minute: merged.minute } : null,
    );
  };

  const dayNames = [
    t("settings.ai.days.sun"), t("settings.ai.days.mon"), t("settings.ai.days.tue"),
    t("settings.ai.days.wed"), t("settings.ai.days.thu"), t("settings.ai.days.fri"),
    t("settings.ai.days.sat"),
  ];

  return (
    <div className="space-y-4">
      {(["Newsletters", "Promotions", "Social", "Updates"] as const).map((cat) => {
        const rule = rules[cat];
        return (
          <div key={cat} className="py-3 px-4 bg-bg-secondary rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-primary">{cat}</span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={rule?.bundled ?? false}
                    onChange={() => saveRule(cat, { bundled: !(rule?.bundled ?? false) })}
                    className="accent-accent"
                  />
                  {t("settings.ai.bundle")}
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={rule?.delivery ?? false}
                    onChange={() => saveRule(cat, { delivery: !(rule?.delivery ?? false) })}
                    className="accent-accent"
                  />
                  {t("settings.ai.schedule")}
                </label>
              </div>
            </div>
            {rule?.delivery && (
              <div className="space-y-2 pt-1">
                <div className="flex gap-1">
                  {dayNames.map((name, idx) => (
                    <button
                      key={name}
                      onClick={() => {
                        const days = rule.days.includes(idx)
                          ? rule.days.filter((d) => d !== idx)
                          : [...rule.days, idx].sort();
                        saveRule(cat, { days });
                      }}
                      className={`w-8 h-7 text-[0.625rem] rounded transition-colors ${
                        rule.days.includes(idx)
                          ? "bg-accent text-white"
                          : "bg-bg-tertiary text-text-tertiary border border-border-primary"
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-tertiary">{t("settings.ai.at")}</span>
                  <input
                    type="time"
                    value={`${String(rule.hour).padStart(2, "0")}:${String(rule.minute).padStart(2, "0")}`}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(":").map(Number);
                      saveRule(cat, { hour: h ?? 9, minute: m ?? 0 });
                    }}
                    className="bg-bg-tertiary text-text-primary text-xs px-2 py-1 rounded border border-border-primary"
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AITab() {
  const accounts = useAccountStore((s) => s.accounts);
  const storedActiveId = useAccountStore((s) => s.activeAccountId);
  const activeAccountId = storedActiveId ?? accounts[0]?.id;

  const [aiProvider, setAiProvider] = useState<AiProvider>("claude");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [copilotApiKey, setCopilotApiKey] = useState("");
  const [kiloApiKey, setKiloApiKey] = useState("");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [nvidiaApiKey, setNvidiaApiKey] = useState("");
  const [ollamaServerUrl, setOllamaServerUrl] = useState("http://localhost:11434");
  const [ollamaModel, setOllamaModel] = useState("llama3.3");
  const [claudeModel, setClaudeModel] = useState("claude-haiku-4-5-20251001");
  const [openaiModel, setOpenaiModel] = useState("gpt-5-mini");
  const [geminiModel, setGeminiModel] = useState(DEFAULT_MODELS.gemini);
  const [copilotModel, setCopilotModel] = useState("openai/gpt-4o-mini");
  const [kiloModel, setKiloModel] = useState("kilo-auto/free");
  const [groqModel, setGroqModel] = useState(DEFAULT_MODELS.groq);
  const [nvidiaModel, setNvidiaModel] = useState(DEFAULT_MODELS.nvidia);
  /** Composer provider ("" = same as the main one) and model ("" = that provider's main model). */
  const [composerProvider, setComposerProvider] = useState<AiProvider | "">("");
  const [composerModel, setComposerModel] = useState("");
  const [configuredProviders, setConfiguredProviders] = useState<AiProvider[]>([]);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiAutoCategorize, setAiAutoCategorize] = useState(true);
  const [aiAutoSummarize, setAiAutoSummarize] = useState(true);
  const [aiAutoSmartReplies, setAiAutoSmartReplies] = useState(false);
  const [phishingAiVerdictEnabled, setPhishingAiVerdictEnabled] = useState(true);
  const [aiKeySaved, setAiKeySaved] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<"success" | "fail" | null>(null);
  const [rateLimit, setRateLimit] = useState<{ pausedUntil: number; backfillResumeAt: number } | null>(null);
  const [aiAutoDraftEnabled, setAiAutoDraftEnabled] = useState(true);
  const [aiWritingStyleEnabled, setAiWritingStyleEnabled] = useState(true);
  const [styleAnalyzing, setStyleAnalyzing] = useState(false);
  const [styleAnalyzeDone, setStyleAnalyzeDone] = useState(false);
  const [aiLanguage, setAiLanguage] = useState("English");
  const [soulEditorOpen, setSoulEditorOpen] = useState(false);
  const [autoArchiveCategories, setAutoArchiveCategories] = useState<Set<string>>(() => new Set());
  const [behaviorEnabled, setBehaviorEnabled] = useState(true);
  const [urgencyEnabled, setUrgencyEnabled] = useState(true);
  const [urgencyMuteWindow, setUrgencyMuteWindow] = useState("30");
  const [urgencyMuteThreshold, setUrgencyMuteThreshold] = useState("3");
  const [urgencyAutoExtinguish, setUrgencyAutoExtinguish] = useState(true);

  useEffect(() => {
    async function load() {
      const provider = await getSetting("ai_provider");
      if (provider === "openai" || provider === "gemini" || provider === "ollama" || provider === "copilot" || provider === "kilo" || provider === "groq" || provider === "nvidia")
        setAiProvider(provider);
      const ollamaUrl = await getSetting("ollama_server_url");
      if (ollamaUrl) setOllamaServerUrl(ollamaUrl);
      const ollamaModelVal = await getSetting("ollama_model");
      if (ollamaModelVal) setOllamaModel(ollamaModelVal);
      const claudeModelVal = await getSetting("claude_model");
      if (claudeModelVal) setClaudeModel(claudeModelVal);
      const openaiModelVal = await getSetting("openai_model");
      if (openaiModelVal) setOpenaiModel(openaiModelVal);
      const geminiModelVal = await getSetting("gemini_model");
      if (geminiModelVal) setGeminiModel(resolveModelId("gemini", geminiModelVal));
      const copilotModelVal = await getSetting("copilot_model");
      if (copilotModelVal) setCopilotModel(copilotModelVal);
      const kiloModelVal = await getSetting("kilo_model");
      if (kiloModelVal) setKiloModel(kiloModelVal);
      const groqModelVal = await getSetting("groq_model");
      if (groqModelVal) setGroqModel(groqModelVal);
      const nvidiaModelVal = await getSetting("nvidia_model");
      if (nvidiaModelVal) setNvidiaModel(nvidiaModelVal);
      const aiKey = await getSecureSetting("claude_api_key");
      setClaudeApiKey(aiKey ?? "");
      const oaiKey = await getSecureSetting("openai_api_key");
      setOpenaiApiKey(oaiKey ?? "");
      const gemKey = await getSecureSetting("gemini_api_key");
      setGeminiApiKey(gemKey ?? "");
      const copKey = await getSecureSetting("copilot_api_key");
      setCopilotApiKey(copKey ?? "");
      const kiloKey = await getSecureSetting("kilo_api_key");
      setKiloApiKey(kiloKey ?? "");
      const groqKey = await getSecureSetting("groq_api_key");
      setGroqApiKey(groqKey ?? "");
      const nvidiaKey = await getSecureSetting("nvidia_api_key");
      setNvidiaApiKey(nvidiaKey ?? "");
      const aiEn = await getSetting("ai_enabled");
      setAiEnabled(aiEn !== "false");
      const aiCat = await getSetting("ai_auto_categorize");
      setAiAutoCategorize(aiCat !== "false");
      const aiSum = await getSetting("ai_auto_summarize");
      setAiAutoSummarize(aiSum !== "false");
      const aiReplies = await getSetting("ai_auto_smart_replies");
      setAiAutoSmartReplies(aiReplies === "true");
      const phishingAi = await getSetting("phishing_ai_verdict_enabled");
      setPhishingAiVerdictEnabled(phishingAi !== "false");
      const aiDraft = await getSetting("ai_auto_draft_enabled");
      setAiAutoDraftEnabled(aiDraft !== "false");
      const aiStyle = await getSetting("ai_writing_style_enabled");
      setAiWritingStyleEnabled(aiStyle !== "false");
      const lang = await getSetting("ai_language");
      if (lang) setAiLanguage(lang);
      const autoArchive = await getSetting("auto_archive_categories");
      if (autoArchive) {
        setAutoArchiveCategories(
          new Set(autoArchive.split(",").map((s) => s.trim()).filter(Boolean)),
        );
      }
      const behaviorEnabledSetting = await getSetting("ai_behavior_enabled");
      setBehaviorEnabled(behaviorEnabledSetting !== "false");
      const urgencyEnabledSetting = await getSetting("ai_urgency_enabled");
      setUrgencyEnabled(urgencyEnabledSetting !== "false");
      const muteWindow = await getSetting("ai_urgency_mute_window_days");
      if (muteWindow) setUrgencyMuteWindow(muteWindow);
      const muteThreshold = await getSetting("ai_urgency_mute_threshold");
      if (muteThreshold) setUrgencyMuteThreshold(muteThreshold);
      const autoExtinguish = await getSetting("ai_urgency_auto_extinguish");
      setUrgencyAutoExtinguish(autoExtinguish !== "false");
    }
    load();
  }, []);

  const currentModel = {
    claude: claudeModel,
    openai: openaiModel,
    gemini: geminiModel,
    copilot: copilotModel,
    kilo: kiloModel,
    groq: groqModel,
    nvidia: nvidiaModel,
    ollama: ollamaModel,
  }[aiProvider];

  const setCurrentModel = (val: string) => {
    if (aiProvider === "claude") setClaudeModel(val);
    else if (aiProvider === "openai") setOpenaiModel(val);
    else if (aiProvider === "gemini") setGeminiModel(val);
    else if (aiProvider === "copilot") setCopilotModel(val);
    else if (aiProvider === "kilo") setKiloModel(val);
    else if (aiProvider === "groq") setGroqModel(val);
    else if (aiProvider === "nvidia") setNvidiaModel(val);
    else setOllamaModel(val);
  };

  useEffect(() => {
    let alive = true;
    const poll = () =>
      import("@/services/ai/rateLimiter")
        .then(({ getRateLimitStatus }) => alive && setRateLimit(getRateLimitStatus()))
        .catch(() => {});
    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Composer provider/model: independent of the main provider, any configured one.
  useEffect(() => {
    let alive = true;
    (async () => {
      const pm = await import("@/services/ai/providerManager");
      const [prov, model, configured] = await Promise.all([
        getSetting(pm.COMPOSER_PROVIDER_SETTING),
        getSetting(pm.COMPOSER_MODEL_SETTING),
        pm.getConfiguredProviders(),
      ]);
      if (!alive) return;
      setComposerProvider((prov as AiProvider | null) ?? "");
      setComposerModel(model ?? "");
      setConfiguredProviders(configured);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [aiProvider, aiKeySaved]);

  /** Composer provider ("" = same as main). Switching provider clears the model: ids differ. */
  const saveComposerProvider = async (value: string) => {
    const pm = await import("@/services/ai/providerManager");
    setComposerProvider(value as AiProvider | "");
    setComposerModel("");
    await setSetting(pm.COMPOSER_PROVIDER_SETTING, value);
    await setSetting(pm.COMPOSER_MODEL_SETTING, "");
    pm.clearProviderClients();
  };

  /** Composer model ("" = the composer provider's own main model). */
  const saveComposerModel = async (value: string) => {
    const pm = await import("@/services/ai/providerManager");
    const val = value.trim();
    setComposerModel(val);
    await setSetting(pm.COMPOSER_MODEL_SETTING, val);
    pm.clearProviderClients();
  };

  const providerLabel = (p: AiProvider): string =>
    ({
      claude: t("settings.ai.providerClaude"),
      openai: t("settings.ai.providerOpenAI"),
      gemini: t("settings.ai.providerGemini"),
      ollama: t("settings.ai.providerOllama"),
      copilot: t("settings.ai.providerCopilot"),
      kilo: t("settings.ai.providerKilo"),
      groq: t("settings.ai.providerGroq"),
      nvidia: t("settings.ai.providerNvidia"),
    })[p];

  const effectiveComposerProvider: AiProvider = composerProvider || aiProvider;

  /** Persist the model of the current provider (empty → provider default). */
  const saveModel = async (value: string) => {
    const { DEFAULT_MODELS: defaults } = await import("@/services/ai/types");
    const { modelSettingKey } = await import("@/services/ai/modelCatalog");
    const val = value.trim() || defaults[aiProvider];
    setCurrentModel(val);
    await setSetting(modelSettingKey(aiProvider), val);
    const { clearProviderClients } = await import("@/services/ai/providerManager");
    clearProviderClients();
  };

  const currentApiKey =
    aiProvider === "claude"
      ? claudeApiKey
      : aiProvider === "openai"
        ? openaiApiKey
        : aiProvider === "copilot"
          ? copilotApiKey
          : aiProvider === "kilo"
            ? kiloApiKey
            : aiProvider === "groq"
              ? groqApiKey
              : aiProvider === "nvidia"
                ? nvidiaApiKey
                : geminiApiKey;

  const handleTestConnection = async () => {
    setAiTesting(true);
    setAiTestResult(null);
    try {
      const { testConnection } = await import("@/services/ai/aiService");
      const ok = await testConnection();
      setAiTestResult(ok ? "success" : "fail");
    } catch {
      setAiTestResult("fail");
    } finally {
      setAiTesting(false);
    }
  };

  return (
    <>
      <Section title={t("settings.ai.sections.provider")} description={t("settings.ai.providerDesc")}>
        <SettingRow label={t("settings.ai.aiProvider")} tip="ai-provider">
          <select
            value={aiProvider}
            onChange={async (e) => {
              const val = e.target.value as typeof aiProvider;
              setAiProvider(val);
              setAiTestResult(null);
              await setSetting("ai_provider", val);
              const { clearProviderClients } = await import("@/services/ai/providerManager");
              clearProviderClients();
            }}
            className="w-64 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
          >
            {/* Alphabetical by label; the local option last, apart from the cloud ones. */}
            <option value="claude">{t("settings.ai.providerClaude")}</option>
            <option value="copilot">{t("settings.ai.providerCopilot")}</option>
            <option value="gemini">{t("settings.ai.providerGemini")}</option>
            <option value="groq">{t("settings.ai.providerGroq")}</option>
            <option value="kilo">{t("settings.ai.providerKilo")}</option>
            <option value="nvidia">{t("settings.ai.providerNvidia")}</option>
            <option value="openai">{t("settings.ai.providerOpenAI")}</option>
            <option value="ollama">{t("settings.ai.providerOllama")}</option>
          </select>
        </SettingRow>
        <p className="text-xs text-text-tertiary">
          {aiProvider === "claude" &&
            t("settings.ai.usesModel", { model: PROVIDER_MODELS.claude.find((m) => m.id === claudeModel)?.label ?? claudeModel })}
          {aiProvider === "openai" &&
            t("settings.ai.usesModel", { model: PROVIDER_MODELS.openai.find((m) => m.id === openaiModel)?.label ?? openaiModel })}
          {aiProvider === "gemini" &&
            t("settings.ai.geminiDesc", { model: PROVIDER_MODELS.gemini.find((m) => m.id === geminiModel)?.label ?? geminiModel })}
          {aiProvider === "ollama" && t("settings.ai.ollamaNoKey")}
          {aiProvider === "copilot" &&
            t("settings.ai.copilotDesc", { model: PROVIDER_MODELS.copilot.find((m) => m.id === copilotModel)?.label ?? copilotModel })}
          {aiProvider === "kilo" &&
            t("settings.ai.kiloDesc", {
              model: PROVIDER_MODELS.kilo.find((m) => m.id === kiloModel)?.label ?? kiloModel,
            })}
          {aiProvider === "groq" &&
            t("settings.ai.groqDesc", {
              model: PROVIDER_MODELS.groq.find((m) => m.id === groqModel)?.label ?? groqModel,
            })}
          {aiProvider === "nvidia" &&
            t("settings.ai.nvidiaDesc", {
              model: PROVIDER_MODELS.nvidia.find((m) => m.id === nvidiaModel)?.label ?? nvidiaModel,
            })}
        </p>
        {rateLimit && (
          <p className="text-xs text-warning">
            {t("settings.ai.rateLimited", {
              live: new Date(rateLimit.pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
              backlog: new Date(rateLimit.backfillResumeAt).toLocaleString([], {
                weekday: "short",
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </p>
        )}
      </Section>

      {aiProvider === "ollama" ? (
        <Section title={t("settings.ai.sections.localServer")}>
          <div className="space-y-3">
            <TextField
              label={t("settings.ai.serverUrl")}
              size="md"
              value={ollamaServerUrl}
              onChange={(e) => setOllamaServerUrl(e.target.value)}
              placeholder="http://localhost:11434"
            />
            <ModelPicker
              provider="ollama"
              value={ollamaModel}
              onChange={setOllamaModel}
              onCommit={(v) => v && saveModel(v)}
              serverUrl={ollamaServerUrl.trim()}
              placeholder="llama3.3"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="md"
                onClick={async () => {
                  await setSetting("ollama_server_url", ollamaServerUrl.trim());
                  await setSetting("ollama_model", ollamaModel.trim());
                  const { clearProviderClients } = await import("@/services/ai/providerManager");
                  clearProviderClients();
                  setAiKeySaved(true);
                  setTimeout(() => setAiKeySaved(false), 2000);
                }}
                disabled={!ollamaServerUrl.trim() || !ollamaModel.trim()}
              >
                {aiKeySaved ? t("settings.ai.saved") : t("settings.ai.save")}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={handleTestConnection}
                disabled={!ollamaServerUrl.trim() || !ollamaModel.trim() || aiTesting}
                className="bg-bg-tertiary text-text-primary border border-border-primary"
              >
                {aiTesting ? t("settings.ai.testing") : t("settings.ai.testConnection")}
              </Button>
              {aiTestResult === "success" && <span className="text-xs text-success">{t("settings.ai.connected")}</span>}
              {aiTestResult === "fail" && <span className="text-xs text-danger">{t("settings.ai.connectionFailed")}</span>}
            </div>
          </div>
        </Section>
      ) : (
        <Section title={t("settings.ai.sections.apiKey")}>
          <div className="space-y-3">
            <TextField
              label={
                aiProvider === "claude"
                  ? t("settings.ai.apiKeyClaude")
                  : aiProvider === "openai"
                    ? t("settings.ai.apiKeyOpenAI")
                    : aiProvider === "copilot"
                      ? t("settings.ai.apiKeyCopilot")
                      : aiProvider === "kilo"
                        ? t("settings.ai.apiKeyKilo")
                        : aiProvider === "groq"
                          ? t("settings.ai.apiKeyGroq")
                          : aiProvider === "nvidia"
                            ? t("settings.ai.apiKeyNvidia")
                            : t("settings.ai.apiKeyGemini")
              }
              size="md"
              type="password"
              value={currentApiKey}
              onChange={(e) => {
                if (aiProvider === "claude") setClaudeApiKey(e.target.value);
                else if (aiProvider === "openai") setOpenaiApiKey(e.target.value);
                else if (aiProvider === "copilot") setCopilotApiKey(e.target.value);
                else if (aiProvider === "kilo") setKiloApiKey(e.target.value);
                else if (aiProvider === "groq") setGroqApiKey(e.target.value);
                else if (aiProvider === "nvidia") setNvidiaApiKey(e.target.value);
                else setGeminiApiKey(e.target.value);
              }}
              placeholder={
                aiProvider === "claude"
                  ? "sk-ant-..."
                  : aiProvider === "openai"
                    ? "sk-..."
                    : aiProvider === "copilot"
                      ? "ghp_..."
                      : aiProvider === "kilo"
                        ? "eyJ..."
                        : aiProvider === "groq"
                          ? "gsk_..."
                          : aiProvider === "nvidia"
                            ? "nvapi-..."
                            : "AI..."
              }
            />
            <ModelPicker
              key={aiProvider}
              provider={aiProvider}
              value={currentModel}
              onChange={setCurrentModel}
              onCommit={saveModel}
              apiKey={currentApiKey.trim()}
              placeholder={PROVIDER_MODELS[aiProvider][0]?.id}
            />
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="md"
                onClick={async () => {
                  await saveModel(currentModel);
                  if (currentApiKey.trim()) {
                    await setSecureSetting(API_KEY_SETTINGS[aiProvider], currentApiKey.trim());
                    const { clearProviderClients } = await import("@/services/ai/providerManager");
                    clearProviderClients();
                  }
                  setAiKeySaved(true);
                  setTimeout(() => setAiKeySaved(false), 2000);
                }}
                disabled={!currentApiKey.trim()}
              >
                {aiKeySaved ? t("settings.ai.saved") : t("settings.ai.saveKey")}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={handleTestConnection}
                disabled={!currentApiKey.trim() || aiTesting}
                className="bg-bg-tertiary text-text-primary border border-border-primary"
              >
                {aiTesting ? t("settings.ai.testing") : t("settings.ai.testConnection")}
              </Button>
              {aiTestResult === "success" && <span className="text-xs text-success">{t("settings.ai.connected")}</span>}
              {aiTestResult === "fail" && <span className="text-xs text-danger">{t("settings.ai.connectionFailed")}</span>}
            </div>
          </div>
        </Section>
      )}

      <Section title={t("settings.ai.sections.composer")} description={t("settings.ai.composerDesc")}>
        <SettingRow label={t("settings.ai.composerProvider")}>
          <select
            value={composerProvider}
            onChange={(e) => saveComposerProvider(e.target.value)}
            className="w-64 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
          >
            <option value="">{t("settings.ai.composerProviderSame", { provider: providerLabel(aiProvider) })}</option>
            {configuredProviders
              .filter((p) => p !== aiProvider)
              .map((p) => (
                <option key={p} value={p}>
                  {providerLabel(p)}
                </option>
              ))}
          </select>
        </SettingRow>
        <ModelPicker
          key={`composer-${effectiveComposerProvider}`}
          provider={effectiveComposerProvider}
          value={composerModel}
          onChange={setComposerModel}
          onCommit={saveComposerModel}
          label={t("settings.ai.composerModel")}
          hint={t("settings.ai.composerModelHint")}
          placeholder={t("settings.ai.composerModelSame")}
        />
      </Section>

      <Section title={t("settings.ai.sections.features")}>
        <ToggleRow
          label={t("settings.ai.enableAI")}
          description={t("settings.ai.enableAIDesc")}
          checked={aiEnabled}
          onToggle={async () => {
            const newVal = !aiEnabled;
            setAiEnabled(newVal);
            await setSetting("ai_enabled", newVal ? "true" : "false");
          }}
        />
        <ToggleRow
          label={t("settings.ai.autoCategorize")}
          description={t("settings.ai.autoCategorizeDesc")}
          checked={aiAutoCategorize}
          onToggle={async () => {
            const newVal = !aiAutoCategorize;
            setAiAutoCategorize(newVal);
            await setSetting("ai_auto_categorize", newVal ? "true" : "false");
          }}
        />
        <ToggleRow
          label={t("settings.ai.autoSummarize")}
          description={t("settings.ai.autoSummarizeDesc")}
          checked={aiAutoSummarize}
          onToggle={async () => {
            const newVal = !aiAutoSummarize;
            setAiAutoSummarize(newVal);
            await setSetting("ai_auto_summarize", newVal ? "true" : "false");
          }}
        />
        <ToggleRow
          label={t("settings.ai.autoSmartReplies")}
          description={t("settings.ai.autoSmartRepliesDesc")}
          checked={aiAutoSmartReplies}
          onToggle={async () => {
            const newVal = !aiAutoSmartReplies;
            setAiAutoSmartReplies(newVal);
            await setSetting("ai_auto_smart_replies", newVal ? "true" : "false");
          }}
        />
        <ToggleRow
          label={t("settings.ai.phishingAiVerdict")}
          description={t("settings.ai.phishingAiVerdictDesc")}
          checked={phishingAiVerdictEnabled}
          onToggle={async () => {
            const newVal = !phishingAiVerdictEnabled;
            setPhishingAiVerdictEnabled(newVal);
            await setSetting("phishing_ai_verdict_enabled", newVal ? "true" : "false");
          }}
        />
        <SettingRow label={t("settings.ai.aiLanguage")}>
          <select
            value={aiLanguage}
            onChange={async (e) => {
              const val = e.target.value;
              setAiLanguage(val);
              await setSetting("ai_language", val);
            }}
            className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
          >
            <option value="English">English</option>
            <option value="Italian">Italiano</option>
            <option value="French">Français</option>
            <option value="German">Deutsch</option>
            <option value="Spanish">Español</option>
            <option value="Portuguese">Português</option>
            <option value="Dutch">Nederlands</option>
          </select>
        </SettingRow>
      </Section>

      <Section title={t("settings.ai.sections.autoDraftReplies")}>
        <ToggleRow
          label={t("settings.ai.autoDraft")}
          description={t("settings.ai.autoDraftDesc")}
          checked={aiAutoDraftEnabled}
          onToggle={async () => {
            const newVal = !aiAutoDraftEnabled;
            setAiAutoDraftEnabled(newVal);
            await setSetting("ai_auto_draft_enabled", newVal ? "true" : "false");
          }}
        />
        <ToggleRow
          label={t("settings.ai.learnWritingStyle")}
          description={t("settings.ai.learnWritingStyleDesc")}
          checked={aiWritingStyleEnabled}
          onToggle={async () => {
            const newVal = !aiWritingStyleEnabled;
            setAiWritingStyleEnabled(newVal);
            await setSetting("ai_writing_style_enabled", newVal ? "true" : "false");
          }}
        />
        {aiWritingStyleEnabled && (
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-text-secondary">{t("settings.ai.writingStyleProfile")}</span>
              <p className="text-xs text-text-tertiary mt-0.5">
                {t("settings.ai.reanalyzeDesc")}
              </p>
            </div>
            <Button
              variant="secondary"
              size="md"
              onClick={async () => {
                setStyleAnalyzing(true);
                setStyleAnalyzeDone(false);
                try {
                  if (activeAccountId) {
                    const { refreshWritingStyle } = await import("@/services/ai/writingStyleService");
                    await refreshWritingStyle(activeAccountId);
                    setStyleAnalyzeDone(true);
                    setTimeout(() => setStyleAnalyzeDone(false), 3000);
                  }
                } catch (err) {
                  console.error("Style analysis failed:", err);
                } finally {
                  setStyleAnalyzing(false);
                }
              }}
              disabled={styleAnalyzing}
              className="bg-bg-tertiary text-text-primary border border-border-primary"
            >
              {styleAnalyzing ? t("settings.ai.analyzing") : styleAnalyzeDone ? t("settings.ai.done") : t("settings.ai.reanalyze")}
            </Button>
          </div>
        )}
      </Section>

      <Section title={t("settings.ai.sections.aiSoul")} description={t("settings.ai.soulDesc")}>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="md" onClick={() => setSoulEditorOpen(true)}>
            {t("settings.ai.editSoul")}
          </Button>
          <span className="text-xs text-text-tertiary">
            {t("settings.ai.soulFileLocation")}
          </span>
        </div>
        <SoulEditorDialog isOpen={soulEditorOpen} onClose={() => setSoulEditorOpen(false)} />
      </Section>

      <Section title={t("settings.ai.sections.categories")}>
        <p className="text-xs text-text-tertiary">
          {t("settings.ai.categoriesDesc")}
        </p>
        <p className="text-xs text-text-tertiary">
          {t("settings.ai.categoriesAutoArchiveDesc")}
        </p>
        {(["Updates", "Promotions", "Social", "Newsletters"] as const).map((cat) => (
          <ToggleRow
            key={cat}
            label={t("settings.ai.autoArchive", { cat })}
            description={t("settings.ai.autoArchiveDesc", { cat: cat.toLowerCase() })}
            checked={autoArchiveCategories.has(cat)}
            onToggle={async () => {
              const next = new Set(autoArchiveCategories);
              if (next.has(cat)) next.delete(cat);
              else next.add(cat);
              setAutoArchiveCategories(next);
              await setSetting("auto_archive_categories", [...next].join(","));
            }}
          />
        ))}
      </Section>

      <Section title={t("settings.ai.sections.bundling")} description={t("settings.ai.bundlingDesc")}>
        <BundleSettings />
      </Section>

      <Section title={t("settings.ai.sections.behavioralIntelligence")} description={t("settings.ai.behavioralIntelligenceDesc")}>
        <ToggleRow
          label={t("settings.ai.enableBehavioral")}
          description={t("settings.ai.enableBehavioralDesc")}
          checked={behaviorEnabled}
          onToggle={async () => {
            const next = !behaviorEnabled;
            setBehaviorEnabled(next);
            await setSetting("ai_behavior_enabled", next ? "true" : "false");
            const { invalidateUrgencySettingsCache, runUrgencyBackfill } = await import(
              "@/services/ai/urgencyPipeline"
            );
            invalidateUrgencySettingsCache();
            if (next) runUrgencyBackfill().catch(() => {});
          }}
        />
        {behaviorEnabled && (
          <div className="mt-3">
            <ToggleRow
              label={t("settings.ai.urgencyIndicators")}
              description={t("settings.ai.urgencyIndicatorsDesc")}
              checked={urgencyEnabled}
              onToggle={async () => {
                const next = !urgencyEnabled;
                setUrgencyEnabled(next);
                await setSetting("ai_urgency_enabled", next ? "true" : "false");
                const { invalidateUrgencySettingsCache } = await import("@/services/ai/urgencyPipeline");
                invalidateUrgencySettingsCache();
              }}
            />
          </div>
        )}
      </Section>

      {behaviorEnabled && (
        <>
          <Section title={t("settings.ai.sections.senderReputation")} description={t("settings.ai.senderReputationDesc")}>
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <TextField
                  label={t("settings.ai.forgivenessWindow")}
                  type="number"
                  min="1"
                  max="365"
                  value={urgencyMuteWindow}
                  onChange={(e) => setUrgencyMuteWindow(e.target.value)}
                />
                <p className="text-xs text-text-tertiary mt-1.5">
                  {t("settings.ai.forgivenessWindowDesc")}
                </p>
              </div>
              <div className="flex-1">
                <TextField
                  label={t("settings.ai.muteThreshold")}
                  type="number"
                  min="1"
                  max="100"
                  value={urgencyMuteThreshold}
                  onChange={(e) => setUrgencyMuteThreshold(e.target.value)}
                />
                <p className="text-xs text-text-tertiary mt-1.5">
                  {t("settings.ai.muteThresholdDesc")}
                </p>
              </div>
            </div>
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={async () => {
                  await setSetting("ai_urgency_mute_window_days", urgencyMuteWindow.trim() || "30");
                  await setSetting("ai_urgency_mute_threshold", urgencyMuteThreshold.trim() || "3");
                  import("@/services/ai/reputationEngine").then(({ purgeOldInteractions }) => {
                    purgeOldInteractions().catch(() => {});
                  });
                }}
              >
                {t("settings.ai.saveAndApply")}
              </Button>
            </div>
          </Section>

          <Section title={t("settings.ai.sections.automation")}>
            <ToggleRow
              label={t("settings.ai.smartAutoExtinguish")}
              description={t("settings.ai.smartAutoExtinguishDesc")}
              checked={urgencyAutoExtinguish}
              onToggle={async () => {
                const next = !urgencyAutoExtinguish;
                setUrgencyAutoExtinguish(next);
                await setSetting("ai_urgency_auto_extinguish", next ? "true" : "false");
              }}
            />
          </Section>
        </>
      )}
    </>
  );
}
