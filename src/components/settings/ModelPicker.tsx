import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RefreshCw, AlertTriangle, ChevronDown, Check } from "lucide-react";
import { t } from "@/i18n";
import type { AiProvider } from "@/services/ai/types";
import type { ModelCatalog, CatalogModel } from "@/services/ai/modelCatalog";

interface ModelPickerProps {
  provider: AiProvider;
  value: string;
  onChange: (value: string) => void;
  /** Persist the value (on blur / on pick). */
  onCommit: (value: string) => void;
  /** Unsaved credentials typed in the form, so the list reflects them. */
  apiKey?: string;
  serverUrl?: string;
  placeholder?: string;
  /** Field label (default: "Model"). */
  label?: string;
  /** Text under the field, replacing the catalog status + provider hint. */
  hint?: string;
}

function formatAge(fetchedAt: number): string {
  const minutes = Math.round((Date.now() - fetchedAt) / 60_000);
  if (minutes < 1) return t("settings.ai.models.justNow");
  if (minutes < 60) return t("settings.ai.models.minutesAgo", { count: minutes });
  return t("settings.ai.models.hoursAgo", { count: Math.round(minutes / 60) });
}

/**
 * Show the WHOLE catalog until the user actually types. A native <datalist>
 * filters by the field's current text, so with "gemini-3.6-flash" already in
 * the field it offered only that one model and hid Gemma and the rest.
 */
export function filterModels(models: CatalogModel[], query: string | null): CatalogModel[] {
  const q = query?.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
}

/**
 * Model combobox: free text + the provider's LIVE catalog (`modelCatalog.ts`,
 * cached 24h) as a dropdown. Any id can be typed; the list only helps.
 */
export function ModelPicker({ provider, value, onChange, onCommit, apiKey, serverUrl, placeholder, label, hint }: ModelPickerProps) {
  const listId = useId();
  const inputId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  /** null = list just opened, show everything; string = user is typing a filter. */
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  const load = async (force: boolean) => {
    setLoading(true);
    try {
      const { getModelCatalog } = await import("@/services/ai/modelCatalog");
      const creds = force && (apiKey || serverUrl) ? { apiKey, serverUrl } : undefined;
      setCatalog(await getModelCatalog(provider, { force, creds }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setCatalog(null);
    import("@/services/ai/modelCatalog")
      .then(({ getModelCatalog }) => getModelCatalog(provider))
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [provider]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const visible = useMemo(() => filterModels(catalog?.models ?? [], query), [catalog, query]);

  const openList = () => {
    setQuery(null);
    setHighlight(Math.max(0, (catalog?.models ?? []).findIndex((m) => m.id === value.trim())));
    setOpen(true);
  };

  const pick = (id: string) => {
    onChange(id);
    onCommit(id);
    setOpen(false);
  };

  const trimmed = value.trim();
  const unknown =
    !!catalog && !catalog.fallback && trimmed.length > 0 && !catalog.models.some((m) => m.id === trimmed);

  return (
    <div ref={rootRef}>
      <label htmlFor={inputId} className="text-sm text-text-secondary block mb-1.5">
        {label ?? t("settings.ai.model")}
      </label>
      <div className="flex items-stretch gap-2">
        <div className="relative flex-1">
          <input
            id={inputId}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            onFocus={openList}
            onClick={() => !open && openList()}
            onChange={(e) => {
              onChange(e.target.value);
              setQuery(e.target.value);
              setHighlight(0);
              setOpen(true);
            }}
            onBlur={() => onCommit(trimmed)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                if (!open) openList();
                else setHighlight((h) => Math.min(h + 1, visible.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter" && open && visible[highlight]) {
                e.preventDefault();
                pick(visible[highlight]!.id);
              } else if (e.key === "Escape" && open) {
                e.stopPropagation();
                setOpen(false);
              }
            }}
            className="w-full px-3 py-2 pr-8 text-sm bg-bg-tertiary border border-border-primary rounded text-text-primary outline-none focus:border-accent"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("settings.ai.model")}
            onMouseDown={(e) => {
              e.preventDefault();
              if (open) setOpen(false);
              else openList();
            }}
            className="absolute inset-y-0 right-0 px-2 text-text-tertiary hover:text-text-primary"
          >
            <ChevronDown size={14} />
          </button>
          {open && visible.length > 0 && (
            <ul
              id={listId}
              role="listbox"
              className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto rounded-md border border-border-primary bg-bg-primary shadow-lg py-1"
            >
              {visible.map((m, i) => (
                <li
                  key={m.id}
                  role="option"
                  aria-selected={m.id === trimmed}
                  ref={i === highlight ? (el) => el?.scrollIntoView?.({ block: "nearest" }) : undefined}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(m.id);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer ${
                    i === highlight ? "bg-bg-hover" : ""
                  }`}
                >
                  <Check size={12} className={m.id === trimmed ? "text-accent" : "invisible"} />
                  <span className="text-text-primary truncate">{m.label}</span>
                  {m.label !== m.id && <span className="text-xs text-text-tertiary truncate">{m.id}</span>}
                  {m.free && provider !== "ollama" && (
                    <span className="ml-auto text-[10px] uppercase tracking-wide text-success shrink-0">
                      {t("settings.ai.kiloFree")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          title={t("settings.ai.models.refresh")}
          aria-label={t("settings.ai.models.refresh")}
          className="px-2.5 rounded border border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
        </button>
      </div>
      <p className="text-xs text-text-tertiary mt-1">
        {hint ??
          (catalog === null
          ? t("settings.ai.models.loading")
          : catalog.fallback
            ? t("settings.ai.models.builtIn")
            : t("settings.ai.models.live", { count: catalog.models.length, age: formatAge(catalog.fetchedAt) }))}
        {!hint && provider === "kilo" && ` ${t("settings.ai.kiloModelHint")}`}
        {!hint && provider === "groq" && ` ${t("settings.ai.groqModelHint")}`}
        {!hint && provider === "nvidia" && ` ${t("settings.ai.nvidiaModelHint")}`}
      </p>
      {unknown && (
        <p className="text-xs text-warning mt-1 flex items-center gap-1">
          <AlertTriangle size={12} />
          {t("settings.ai.models.notInCatalog")}
        </p>
      )}
    </div>
  );
}
