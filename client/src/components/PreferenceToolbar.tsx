import { UserPreferences } from "../lib/types";
import clsx from "clsx";

export const DIETARY_OPTIONS: Array<{ id: string; label: string; emoji: string }> = [
  { id: "vegetarian", label: "Vegetarian", emoji: "🥗" },
  { id: "vegan", label: "Vegan", emoji: "🌱" },
  { id: "gluten_free", label: "Gluten-free", emoji: "🌾" },
  { id: "low_calorie", label: "Low calorie", emoji: "⚖️" },
  { id: "high_protein", label: "High protein", emoji: "💪" },
];

type PreferenceToolbarProps = {
  preferences: UserPreferences;
  onChange: (next: UserPreferences) => void;
  disabled?: boolean;
};

export function PreferenceToolbar({ preferences, onChange, disabled }: PreferenceToolbarProps) {
  const active = new Set(preferences.dietaryTags);

  const toggle = (id: string) => {
    if (disabled) return;
    const next = new Set(active);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange({ dietaryTags: Array.from(next) });
  };

  const clearAll = () => {
    if (disabled) return;
    onChange({ dietaryTags: [] });
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-4 py-5 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-primary/15 text-primary-dark px-3 py-1 text-xs font-semibold uppercase tracking-wide">
            Personalise basket
          </span>
          <h3 className="text-base font-semibold tracking-tight">Dietary & lifestyle filters</h3>
        </div>
        <button
          type="button"
          onClick={clearAll}
          disabled={disabled || active.size === 0}
          className={clsx(
            "text-xs px-3 py-1 rounded-full border transition",
            active.size === 0 || disabled
              ? "border-slate-200 text-slate-400 cursor-not-allowed"
              : "border-slate-300 text-slate-600 hover:text-slate-900 hover:border-slate-400"
          )}
        >
          Clear
        </button>
      </header>
      <p className="text-xs text-slate-500">
        Toggle any preferences that should strictly apply to product results. Elastic filters first,
        then Bedrock reasons within the tailored set.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {DIETARY_OPTIONS.map((option) => {
          const selected = active.has(option.id);
          return (
            <button
              type="button"
              key={option.id}
              onClick={() => toggle(option.id)}
              disabled={disabled}
              className={clsx(
                "flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition",
                selected
                  ? "border-primary/40 bg-primary/10 text-primary-dark shadow-sm"
                  : "border-slate-200 hover:border-slate-300 text-slate-600"
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-base">{option.emoji}</span>
                {option.label}
              </span>
              <span
                className={clsx(
                  "w-2.5 h-2.5 rounded-full border",
                  selected ? "bg-primary-dark border-primary-dark" : "border-slate-300"
                )}
              />
            </button>
          );
        })}
      </div>
      {active.size > 0 && (
        <p className="text-xs text-slate-500">
          Applied filters: {Array.from(active).map((tag) => tag.replace(/_/g, " ")).join(", ")}
        </p>
      )}
    </div>
  );
}
