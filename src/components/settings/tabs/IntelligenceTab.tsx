import { useState, useEffect } from "react";
import { useAccountStore } from "@/stores/accountStore";
import { getSetting, setSetting } from "@/services/db/settings";
import { Section, ToggleRow } from "./shared";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";

export function IntelligenceTab() {
  const accounts = useAccountStore((s) => s.accounts);

  const [ragEnabled, setRagEnabled] = useState(false);
  const [embeddingModel, setEmbeddingModel] = useState("nomic-embed-text");
  const [ollamaServerUrl, setOllamaServerUrl] = useState("http://localhost:11434");
  const [ragChunkSize, setRagChunkSize] = useState("512");
  const [ragBatchSize, setRagBatchSize] = useState("10");
  const [ragProgress, setRagProgress] = useState<{ indexed: number; total: number } | null>(null);
  const [ragTesting, setRagTesting] = useState(false);
  const [ragTestResult, setRagTestResult] = useState<"success" | "fail" | null>(null);
  const [ragTestError, setRagTestError] = useState<"server_down" | "model_not_found" | "unknown" | null>(null);
  const [ragDimensions, setRagDimensions] = useState<number | null>(null);
  const [ragSaved, setRagSaved] = useState(false);
  const [ragRunning, setRagRunning] = useState(false);
  const [ragError, setRagError] = useState<string | null>(null);
  const [ragPriorityDomains, setRagPriorityDomains] = useState("");
  const [urgencyDecayStart, setUrgencyDecayStart] = useState("20");
  const [urgencyDecayFloor, setUrgencyDecayFloor] = useState("30");
  const [ragDiagOpen, setRagDiagOpen] = useState(false);
  const [ragDiagData, setRagDiagData] = useState<any>(null);
  const [accountRagFlags, setAccountRagFlags] = useState<Record<string, boolean>>({});
  const [ragReindexConfirm, setRagReindexConfirm] = useState(false);
  const [ragClearing, setRagClearing] = useState(false);

  useEffect(() => {
    async function load() {
      const ragEn = await getSetting("rag_enabled");
      setRagEnabled(ragEn === "true");
      const ollamaUrl = await getSetting("ollama_server_url");
      if (ollamaUrl) setOllamaServerUrl(ollamaUrl);
      const embModel = await getSetting("embedding_model");
      if (embModel) setEmbeddingModel(embModel);
      const chunkSz = await getSetting("rag_chunk_size");
      if (chunkSz) setRagChunkSize(chunkSz);
      const batchSz = await getSetting("rag_batch_size");
      if (batchSz) setRagBatchSize(batchSz);
      const decayStart = await getSetting("ai_urgency_decay_start_days");
      if (decayStart) setUrgencyDecayStart(decayStart);
      const decayFloor = await getSetting("ai_urgency_decay_floor_days");
      if (decayFloor) setUrgencyDecayFloor(decayFloor);
      const priorityDomains = await getSetting("rag_priority_domains");
      if (priorityDomains !== null) setRagPriorityDomains(priorityDomains);

      try {
        const { getAccountRagEnabled } = await import("@/services/db/accounts");
        const flags: Record<string, boolean> = {};
        for (const acc of accounts) {
          flags[acc.id] = await getAccountRagEnabled(acc.id);
        }
        setAccountRagFlags(flags);

        const ragEnabledIds = accounts.filter((a) => flags[a.id]).map((a) => a.id);
        if (ragEnabledIds.length > 0) {
          const { getEmbeddingProgressAll } = await import("@/services/ai/ollamaEmbeddings");
          setRagProgress(await getEmbeddingProgressAll(ragEnabledIds));
        }
      } catch (err) {
        console.error("Failed to load RAG flags:", err);
      }
    }
    load();
  }, [accounts]);

  // Auto-refresh RAG progress while tab is visible and indexing is running
  useEffect(() => {
    if (!ragEnabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      if (cancelled) return;
      const { getEmbeddingProgressAll } = await import("@/services/ai/ollamaEmbeddings");
      const ragEnabledIds = accounts.filter((a) => accountRagFlags[a.id]).map((a) => a.id);
      if (ragEnabledIds.length > 0) {
        const progress = await getEmbeddingProgressAll(ragEnabledIds);
        if (!cancelled) setRagProgress(progress);
      }
      if (cancelled) return;
      const { isEmbeddingBackfillRunning, getLastError } = await import("@/services/ai/embeddingBackfill");
      if (!cancelled) {
        setRagRunning(isEmbeddingBackfillRunning());
        setRagError(getLastError());
        timer = setTimeout(refresh, 3000);
      }
    };
    refresh();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ragEnabled, accounts, accountRagFlags]);

  return (
    <>
      <Section title="Privacy & Local Processing">
        <div className="rounded-md bg-bg-tertiary border border-border-primary px-3 py-3 text-sm text-text-secondary leading-relaxed">
          <p className="font-medium text-text-primary mb-1">100% On-device — no data leaves your machine</p>
          <p className="text-xs">
            Melo uses a local Ollama server (
            <code className="bg-bg-secondary px-1 rounded">localhost:11434</code>) to generate vector
            embeddings of your emails. These embeddings are stored in the local SQLite database and never sent
            to any external server. Semantic search uses cosine similarity computed in-process.
          </p>
        </div>
      </Section>

      <Section title="Semantic Search (RAG)">
        <p className="text-xs text-text-tertiary mb-3">
          When enabled, Ask My Inbox combines keyword search (FTS5) with vector similarity for smarter,
          context-aware results. Emails are indexed in the background in small batches — the app stays
          responsive.
        </p>
        <ToggleRow
          label="Enable Semantic Search"
          description="Index emails locally and mix vector similarity into Ask My Inbox results (40% keyword + 60% semantic)"
          checked={ragEnabled}
          onToggle={async () => {
            const next = !ragEnabled;
            setRagEnabled(next);
            await setSetting("rag_enabled", next ? "true" : "false");
            if (next) {
              const { runEmbeddingBackfill } = await import("@/services/ai/embeddingBackfill");
              runEmbeddingBackfill().catch(() => {});
            } else {
              const { stopEmbeddingBackfill } = await import("@/services/ai/embeddingBackfill");
              stopEmbeddingBackfill();
            }
          }}
        />
      </Section>

      <Section title="Indexed Accounts">
        <p className="text-xs text-text-tertiary mb-3">
          Enable semantic indexing per account. Only enabled accounts are indexed by the background backfill
          job and included in Ask My Inbox semantic results.
        </p>
        {accounts.length === 0 ? (
          <p className="text-xs text-text-tertiary">No accounts configured.</p>
        ) : (
          <div className="space-y-2">
            {accounts.map((acc) => (
              <ToggleRow
                key={acc.id}
                label={acc.email}
                description={`${acc.provider === "gmail" ? "Gmail" : "IMAP"} account`}
                checked={accountRagFlags[acc.id] ?? false}
                onToggle={async () => {
                  const next = !(accountRagFlags[acc.id] ?? false);
                  setAccountRagFlags((prev) => ({ ...prev, [acc.id]: next }));
                  const { setAccountRagEnabled } = await import("@/services/db/accounts");
                  await setAccountRagEnabled(acc.id, next);
                  if (next && ragEnabled) {
                    const { runEmbeddingBackfill } = await import("@/services/ai/embeddingBackfill");
                    runEmbeddingBackfill().catch(() => {});
                  }
                  const { getEmbeddingProgressAll } = await import("@/services/ai/ollamaEmbeddings");
                  const updatedFlags = { ...accountRagFlags, [acc.id]: next };
                  const ragEnabledIds = accounts.filter((a) => updatedFlags[a.id]).map((a) => a.id);
                  if (ragEnabledIds.length > 0) {
                    setRagProgress(await getEmbeddingProgressAll(ragEnabledIds));
                  } else {
                    setRagProgress(null);
                  }
                }}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Embedding Model">
        <p className="text-xs text-text-tertiary mb-3">
          Configure the Ollama server and model used for generating email embeddings. The server URL is shared
          with the AI tab. Pull the model first:{" "}
          <code className="bg-bg-tertiary px-1 rounded">ollama pull nomic-embed-text</code>
        </p>
        <div className="space-y-3">
          <TextField
            label="Ollama Server URL"
            size="md"
            value={ollamaServerUrl}
            onChange={(e) => setOllamaServerUrl(e.target.value)}
            placeholder="http://localhost:11434"
          />
          <TextField
            label="Embedding Model"
            size="md"
            value={embeddingModel}
            onChange={(e) => setEmbeddingModel(e.target.value)}
            placeholder="nomic-embed-text"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="md"
              onClick={async () => {
                await setSetting("ollama_server_url", ollamaServerUrl.trim() || "http://localhost:11434");
                await setSetting("embedding_model", embeddingModel.trim() || "nomic-embed-text");
                setRagSaved(true);
                setTimeout(() => setRagSaved(false), 2000);
              }}
            >
              {ragSaved ? "Saved!" : "Save"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={async () => {
                setRagTesting(true);
                setRagTestResult(null);
                setRagTestError(null);
                setRagDimensions(null);
                try {
                  const { testEmbeddingModel } = await import("@/services/ai/ollamaEmbeddings");
                  const res = await testEmbeddingModel(
                    ollamaServerUrl.trim() || "http://localhost:11434",
                    embeddingModel.trim() || "nomic-embed-text",
                  );
                  setRagTestResult(res.ok ? "success" : "fail");
                  if (res.ok) {
                    setRagDimensions(res.dimensions ?? null);
                  } else {
                    setRagTestError(res.errorType ?? "unknown");
                  }
                } catch {
                  setRagTestResult("fail");
                  setRagTestError("unknown");
                } finally {
                  setRagTesting(false);
                }
              }}
              disabled={ragTesting || !ollamaServerUrl.trim()}
              className="bg-bg-tertiary text-text-primary border border-border-primary"
            >
              {ragTesting ? "Testing..." : "Test Embedding Model"}
            </Button>
            {ragTestResult === "success" && (
              <span className="text-xs text-success">
                Model responding!{ragDimensions ? ` (${ragDimensions} dimensions)` : ""}
              </span>
            )}
            {ragTestResult === "fail" && ragTestError === "server_down" && (
              <span className="text-xs text-danger">Server unreachable — is Ollama running?</span>
            )}
            {ragTestResult === "fail" && ragTestError === "model_not_found" && (
              <span className="text-xs text-danger">
                Model not found — run: <code>ollama pull {embeddingModel || "nomic-embed-text"}</code>
              </span>
            )}
            {ragTestResult === "fail" && ragTestError === "unknown" && (
              <span className="text-xs text-danger">Test failed — check server URL and model name</span>
            )}
          </div>
        </div>
      </Section>

      <Section title="Indexing Parameters">
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <TextField
              label="Chunk Size (approx. tokens)"
              size="md"
              value={ragChunkSize}
              onChange={(e) => setRagChunkSize(e.target.value)}
              placeholder="512"
            />
            <p className="text-xs text-text-tertiary mt-1.5">
              How much text to embed per email. Larger values capture more context but increase Ollama memory
              usage. Default 512 ≈ 2 KB of text; max for nomic-embed-text is 8192 tokens.
            </p>
          </div>
          <div className="flex-1">
            <TextField
              label="Batch Size"
              size="md"
              value={ragBatchSize}
              onChange={(e) => setRagBatchSize(e.target.value)}
              placeholder="10"
            />
            <p className="text-xs text-text-tertiary mt-1.5">
              Emails processed per indexing cycle (50ms pause between each). Higher values speed up indexing
              but increase CPU load — keep at 5–20 for background comfort.
            </p>
          </div>
        </div>
        <Button
          variant="primary"
          size="md"
          className="mt-3"
          onClick={async () => {
            await setSetting("rag_chunk_size", ragChunkSize.trim() || "512");
            await setSetting("rag_batch_size", ragBatchSize.trim() || "10");
            setRagSaved(true);
            setTimeout(() => setRagSaved(false), 2000);
          }}
        >
          {ragSaved ? "Saved!" : "Save Parameters"}
        </Button>
      </Section>

      <Section title="Indexing Progress">
        <div>
          <div className="flex justify-between text-sm mb-2">
            <span className="text-text-secondary">Emails indexed</span>
            <span className="text-text-primary font-medium tabular-nums">
              {ragProgress
                ? `${ragProgress.indexed.toLocaleString()} / ${ragProgress.total.toLocaleString()}`
                : "— / —"}
            </span>
          </div>
          <div className="w-full bg-bg-tertiary rounded-full h-2 border border-border-primary">
            <div
              className="bg-accent h-2 rounded-full transition-all duration-300"
              style={{
                width:
                  ragProgress && ragProgress.total > 0
                    ? `${Math.min(100, (ragProgress.indexed / ragProgress.total) * 100)}%`
                    : "0%",
              }}
            />
          </div>
          <p className="text-xs text-text-tertiary mt-2">
            {!ragProgress
              ? accounts.some((a) => accountRagFlags[a.id])
                ? "Loading indexing data…"
                : "Enable semantic indexing for at least one account above to start indexing."
              : ragProgress.indexed >= ragProgress.total && ragProgress.total > 0
                ? "All emails indexed. Semantic search is fully operational."
                : ragProgress.indexed > ragProgress.total
                  ? `Indexing complete — ${(ragProgress.indexed - ragProgress.total).toLocaleString()} emails had no embeddable content`
                  : ragRunning
                    ? `Indexing in progress — ${(ragProgress.total - ragProgress.indexed).toLocaleString()} remaining`
                    : `Paused — ${(ragProgress.total - ragProgress.indexed).toLocaleString()} emails remaining`}
          </p>
          {ragError && <p className="text-xs text-danger mt-1">{ragError}</p>}
          <div className="flex gap-2 mt-3">
            {ragProgress && ragProgress.indexed < ragProgress.total && ragEnabled && (
              <Button
                variant="secondary"
                size="md"
                className="bg-bg-tertiary text-text-primary border border-border-primary"
                onClick={async () => {
                  const { runEmbeddingBackfill, isEmbeddingBackfillRunning, getLastError } = await import(
                    "@/services/ai/embeddingBackfill"
                  );
                  runEmbeddingBackfill().catch(() => {});
                  setRagRunning(isEmbeddingBackfillRunning());
                  setRagError(getLastError());
                }}
              >
                {ragRunning ? "Restart Indexing" : "Resume Indexing"}
              </Button>
            )}
            <Button
              variant="secondary"
              size="md"
              className="bg-bg-tertiary text-text-primary border border-border-primary"
              onClick={async () => {
                if (ragDiagOpen) {
                  setRagDiagOpen(false);
                  return;
                }
                const { getDiagnostics } = await import("@/services/ai/embeddingBackfill");
                const diag = await getDiagnostics();
                setRagDiagData(diag);
                setRagDiagOpen(true);
              }}
            >
              {ragDiagOpen ? "Hide Diagnostics" : "Detailed Diagnostics"}
            </Button>
          </div>

          {ragEnabled && ragProgress && ragProgress.total > 0 && (
            <div className="mt-3 pt-3 border-t border-border-secondary">
              {!ragReindexConfirm ? (
                <Button
                  variant="secondary"
                  size="md"
                  className="bg-bg-tertiary text-text-secondary border border-border-primary hover:border-danger hover:text-danger transition-colors"
                  onClick={() => setRagReindexConfirm(true)}
                >
                  Re-index from scratch
                </Button>
              ) : (
                <div className="flex items-center gap-3">
                  <p className="text-xs text-danger flex-1">
                    This will delete all {ragProgress.indexed.toLocaleString()} embeddings and re-index from
                    scratch. Continue?
                  </p>
                  <Button
                    variant="secondary"
                    size="md"
                    className="bg-bg-tertiary text-text-secondary border border-border-primary shrink-0"
                    onClick={() => setRagReindexConfirm(false)}
                    disabled={ragClearing}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="secondary"
                    size="md"
                    className="bg-danger/10 text-danger border border-danger/30 shrink-0"
                    disabled={ragClearing}
                    onClick={async () => {
                      setRagClearing(true);
                      try {
                        const {
                          stopEmbeddingBackfill,
                          clearAllEmbeddings,
                          runEmbeddingBackfill,
                          isEmbeddingBackfillRunning,
                          getLastError,
                        } = await import("@/services/ai/embeddingBackfill");
                        stopEmbeddingBackfill();
                        await new Promise((r) => setTimeout(r, 300));
                        await clearAllEmbeddings();
                        setRagProgress({ indexed: 0, total: ragProgress.total });
                        setRagDiagOpen(false);
                        runEmbeddingBackfill().catch(() => {});
                        setRagRunning(isEmbeddingBackfillRunning());
                        setRagError(getLastError());
                      } finally {
                        setRagClearing(false);
                        setRagReindexConfirm(false);
                      }
                    }}
                  >
                    {ragClearing ? "Clearing…" : "Confirm"}
                  </Button>
                </div>
              )}
            </div>
          )}

          {ragDiagOpen && ragDiagData && (
            <div className="mt-4 p-4 rounded-lg bg-bg-secondary border border-border-primary space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
              <h4 className="text-xs font-bold uppercase tracking-wider text-text-tertiary mb-2">
                Internal Index State
              </h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-[10px] text-text-tertiary uppercase">Database Totals</p>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-text-secondary">Total Messages</span>
                    <span className="text-sm font-medium tabular-nums">
                      {ragDiagData.totalMessages.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-text-secondary">RAG-Enabled Accounts</span>
                    <span className="text-sm font-medium tabular-nums">{ragDiagData.ragAccounts}</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] text-text-tertiary uppercase">Eligibility</p>
                  <div className="flex justify-between items-baseline border-b border-border-primary pb-1 mb-1">
                    <span className="text-xs text-text-secondary font-semibold">Eligible Messages</span>
                    <span className="text-sm font-bold tabular-nums text-accent">
                      {ragDiagData.eligibleMessages.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-text-secondary">Successfully Indexed</span>
                    <span className="text-sm font-medium tabular-nums text-success">
                      {ragDiagData.indexed.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-text-secondary">No Content (Sentinels)</span>
                    <span className="text-sm font-medium tabular-nums text-text-tertiary">
                      {ragDiagData.sentinels.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline pt-1">
                    <span className="text-xs text-text-secondary">Pending Processing</span>
                    <span className="text-sm font-medium tabular-nums text-warning">
                      {ragDiagData.pending.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
              <div className="pt-2 border-t border-border-primary">
                <p className="text-[10px] text-text-tertiary leading-relaxed italic">
                  * Eligible messages exclude Spam, Trash, and accounts where semantic search is disabled.
                  Sentinels mark messages that were processed but had insufficient text for embedding.
                </p>
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section title="Temporal Aging">
        <p className="text-xs text-text-tertiary mb-3">
          Urgency naturally fades as threads grow older. Between the start and floor day, the score linearly
          decays toward a dim minimum. Beyond the floor, urgency is silenced automatically.
        </p>
        <div className="flex items-start gap-4 mb-3">
          <div className="flex-1">
            <TextField
              label="Decay Start (days)"
              type="number"
              min="1"
              max="365"
              value={urgencyDecayStart}
              onChange={(e) => setUrgencyDecayStart(e.target.value)}
            />
            <p className="text-xs text-text-tertiary mt-1.5">
              Urgency is unchanged until this many days after the last message.
            </p>
          </div>
          <div className="flex-1">
            <TextField
              label="Decay Floor (days)"
              type="number"
              min="1"
              max="365"
              value={urgencyDecayFloor}
              onChange={(e) => setUrgencyDecayFloor(e.target.value)}
            />
            <p className="text-xs text-text-tertiary mt-1.5">
              At this age, urgency reaches its minimum (dim indicator, not hidden). Must be &gt; Decay Start.
            </p>
          </div>
        </div>
        <p className="text-xs text-text-tertiary mb-3 bg-bg-tertiary rounded-lg px-3 py-2">
          Example: with Start=20 and Floor=30, a thread that's 25 days old loses 50% of its urgency. At 30+
          days it shows only a faint indicator.
        </p>
        <Button
          variant="secondary"
          onClick={async () => {
            const start = Math.max(1, parseInt(urgencyDecayStart.trim() || "20", 10));
            const floor = Math.max(start + 1, parseInt(urgencyDecayFloor.trim() || "30", 10));
            setUrgencyDecayStart(String(start));
            setUrgencyDecayFloor(String(floor));
            await setSetting("ai_urgency_decay_start_days", String(start));
            await setSetting("ai_urgency_decay_floor_days", String(floor));
          }}
        >
          Save Aging Rules
        </Button>
      </Section>

      <Section title="Priority Domains">
        <p className="text-xs text-text-tertiary mb-3">
          Emails from these domains, or emails mentioning new projects and quotes, receive a +0.15–0.3 urgency
          boost regardless of keywords. Comma-separated (e.g.{" "}
          <span className="font-mono">client.com, partner.io</span>).
        </p>
        <TextField
          label="Priority domains"
          placeholder="client.com, partner.io"
          value={ragPriorityDomains}
          onChange={(e) => setRagPriorityDomains(e.target.value)}
        />
        <div className="mt-3">
          <Button
            variant="secondary"
            onClick={async () => {
              await setSetting("rag_priority_domains", ragPriorityDomains.trim());
            }}
          >
            Save Domains
          </Button>
        </div>
      </Section>
    </>
  );
}
