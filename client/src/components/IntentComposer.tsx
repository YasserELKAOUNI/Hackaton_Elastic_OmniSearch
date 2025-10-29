import { FormEvent, useEffect, useState } from "react";
import { IntentPreset } from "../App";
import clsx from "clsx";

type IntentComposerProps = {
  presets: IntentPreset[];
  onSubmit: (nlQuery: string) => void;
  isLoading?: boolean;
  defaultValue?: string;
  // When provided, the component aligns its budget slider a posteriori
  // to the effective budget enforced by the backend.
  effectiveBudget?: number | null;
};

export function IntentComposer({ presets, onSubmit, isLoading, defaultValue = "", effectiveBudget }: IntentComposerProps) {
  const [value, setValue] = useState(defaultValue);
  const [servings, setServings] = useState(4);
  const [budget, setBudget] = useState(20);

  // Extract the base query and any household from the provided defaultValue.
  useEffect(() => {
    if (!defaultValue) {
      setValue("");
      return;
    }
    // Remove trailing clauses we append in the UI so the input shows the natural core.
    const base = defaultValue
      .replace(/\s+for\s+\d+\s+(?:people|person|ppl)/i, "")
      .replace(/\s+pour\s+\d+\s+(?:personnes?|pers?\.?)/i, "")
      .replace(/\s+with\s+budget\s+under\s+€\d+(?:[.,]\d+)?/i, "")
      .replace(/\s+under\s+€\d+(?:[.,]\d+)?/i, "")
      .trim();
    setValue(base.length ? base : defaultValue.trim());

    // Infer household from the text and align the slider if present.
    const hh = householdFromText(defaultValue);
    if (typeof hh === "number" && hh > 0) {
      setServings(Math.max(1, Math.min(8, hh)));
    }
  }, [defaultValue]);

  // If the backend reports an effective budget, align the slider to it (a posteriori).
  useEffect(() => {
    if (typeof effectiveBudget === "number" && Number.isFinite(effectiveBudget) && effectiveBudget > 0) {
      setBudget(Math.round(effectiveBudget));
    }
  }, [effectiveBudget]);

  const hasBudgetInText = (text: string) => {
    if (!text) return false;
    const lower = text.toLowerCase();
    // Match common patterns: "€ 12", "12€", "under 12", "budget under 12"
    const euroSymbol = /€\s*\d+(?:[.,]\d+)?/;
    const trailingEuro = /\d+(?:[.,]\d+)?\s*(?:€|eur|euro)s?/;
    const keywordBudget = /(?:under|below|less than|<=|budget\s*(?:under|below|less than)?)\s*(?:€|\s*euros?|eur)?\s*\d+(?:[.,]\d+)?/;
    return euroSymbol.test(lower) || trailingEuro.test(lower) || keywordBudget.test(lower);
  };

  const householdFromText = (text: string): number | null => {
    if (!text) return null;
    const patterns = [
      /for\s+(\d+)\s+(?:people|person|ppl)/i,               // English
      /pour\s+(\d+)\s+(?:personnes?|pers?\.?)/i,            // French
      /\b(\d+)\s*(?:ppl|persons?|personnes?)\b/i            // Loose form
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1]) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return null;
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    const base = value.trim();
    // Avoid duplicating household/budget if already present in text
    const parts: string[] = [];
    if (!householdFromText(base)) parts.push(`for ${servings} people`);
    if (!hasBudgetInText(base)) parts.push(`with budget under €${budget}`);
    const suffix = parts.length ? ` ${parts.join(" ")}` : "";
    onSubmit(`${base}${suffix}`);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">
            Describe your basket
          </span>
          <div className="flex items-center gap-2 bg-slate-100 border border-slate-200 rounded-full px-4 py-2 focus-within:border-primary-light focus-within:ring-1 focus-within:ring-primary-light transition">
            <span className="text-slate-400 text-lg">🔍</span>
            <input
              type="text"
              className="flex-1 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
              value={value}
              placeholder="Healthy breakfast for kids under €10"
              onChange={(event) => setValue(event.target.value)}
            />
            <button
              type="submit"
              className="hidden sm:inline-flex items-center gap-2 rounded-full bg-primary-light px-4 py-1.5 text-sm font-medium text-white transition hover:bg-primary-dark disabled:opacity-60"
              disabled={isLoading}
            >
              {isLoading ? "Thinking…" : "Search"}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="flex items-center gap-3">
            <span className="uppercase tracking-wide text-[10px] text-slate-500">
              Household
            </span>
            <input
              type="range"
              min={1}
              max={8}
              value={servings}
              onChange={(event) => setServings(Number(event.target.value))}
              className="w-28 accent-primary-light"
            />
            <span className="text-slate-700 text-sm font-medium">{servings} ppl</span>
          </label>
          <label className="flex items-center gap-3">
            <span className="uppercase tracking-wide text-[10px] text-slate-500">
              Budget (€)
            </span>
            <input
              type="range"
              min={5}
              max={60}
              step={1}
              value={budget}
              onChange={(event) => setBudget(Number(event.target.value))}
              className="w-28 accent-primary-light"
            />
            <span className="text-slate-700 text-sm font-medium">≤ €{budget}</span>
          </label>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {presets.map((preset) => {
            const isActive = value.trim() === preset.prompt.trim();
            return (
              <button
                key={preset.prompt}
                type="button"
                onClick={() => {
                  setValue(preset.prompt);
                  const base = preset.prompt.trim();
                  const parts: string[] = [];
                  if (!householdFromText(base)) parts.push(`for ${servings} people`);
                  if (!hasBudgetInText(base)) parts.push(`with budget under €${budget}`);
                  const suffix = parts.length ? ` ${parts.join(" ")}` : "";
                  onSubmit(`${base}${suffix}`);
                }}
                className={clsx(
                  "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition",
                  isActive
                    ? "border-primary-light bg-primary-light/20 text-primary-dark"
                    : "border-slate-200 text-slate-600 hover:border-primary-light hover:text-primary-dark"
                )}
              >
                <span>{preset.icon}</span>
                <span>{preset.label}</span>
              </button>
            );
          })}
        </div>

        <button
          type="submit"
          className="w-full rounded-full bg-primary-light py-2 text-sm font-semibold text-white transition hover:bg-primary-dark disabled:opacity-60 sm:hidden"
          disabled={isLoading}
        >
          {isLoading ? "Thinking…" : "Search"}
        </button>
      </form>
    </div>
  );
}
