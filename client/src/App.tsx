import { FormEvent, useEffect, useState } from "react";
import clsx from "clsx";
import { AssistantView } from "./components/AssistantView";
import { IntentComposer } from "./components/IntentComposer";
import { InsightsPanel } from "./components/InsightsPanel";
import { ConversationDock } from "./components/ConversationDock";
import { useAssistant } from "./hooks/useAssistant";
import { PreferenceToolbar, DIETARY_OPTIONS } from "./components/PreferenceToolbar";
import { PolicyMode, UserPreferences } from "./lib/types";
import { SearchGrid } from "./components/SearchGrid";

type ViewMode = "default" | "storefront";

function resolveViewFromPath(): ViewMode {
  if (typeof window === "undefined") return "default";
  if (window.location.pathname === "/search") return "storefront";
  return "default";
}

export type IntentPreset = {
  label: string;
  prompt: string;
  icon: string;
};

const INTENT_PRESETS: IntentPreset[] = [
  {
    label: "Market salad prep",
    prompt: "Tomates, salade & fromage ideas under €12 for 2 people",
    icon: "🍅",
  },
  {
    label: "Lunchbox boosters",
    prompt: "Jus, yaourt and kid-friendly snacks under €8",
    icon: "🥤",
  },
  {
    label: "Weeknight poulet fuel",
    prompt: "High-protein poulet dinner under €18 for 4 people",
    icon: "🍗",
  },
  {
    label: "Vegan sunrise",
    prompt: "Vegan breakfast staples (lait, pain, compote) under €10",
    icon: "🌱",
  },
  {
    label: "Gluten-free pasta night",
    prompt: "Gluten-free pâtes & sauces under €15 for 3 people",
    icon: "🍝",
  },
  {
    label: "Low-calorie fridge reset",
    prompt: "Low-calorie salades & jus under €11",
    icon: "⚖️",
  },
  {
    label: "Comfort pantry top-up",
    prompt: "Fromage, beurre & pain treats under €14",
    icon: "🧀",
  },
];

export default function App() {
  const [query, setQuery] = useState("Healthy breakfast for kids under €10");
  const [forceSonnet, setForceSonnet] = useState(false);
  const [policyMode, setPolicyMode] = useState<PolicyMode>("semi_managed");
  const [useAgentCore, setUseAgentCore] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(resolveViewFromPath);
  const [searchDraft, setSearchDraft] = useState(query);
  const [preferences, setPreferences] = useState<UserPreferences>({ dietaryTags: [] });
  const {
    data,
    isLoading,
    isError,
    trigger,
    conversation,
    mutateConversation,
  } = useAssistant();

  const applyPreferences = (next: UserPreferences, rerank = true) => {
    setPreferences(next);
    trigger(query, {
      useBedrock: forceSonnet,
      preferences: next,
      rerank,
      policyMode,
      useAgentCore,
    });
  };

  const handleSearch = (nlQuery: string) => {
    setQuery(nlQuery);
    setSearchDraft(nlQuery);
    trigger(nlQuery, { useBedrock: forceSonnet, preferences, policyMode, useAgentCore });
  };

  const handlePreferenceChange = (next: UserPreferences) => {
    applyPreferences(next, true);
  };

  const toggleDietaryTag = (id: string) => {
    const nextSet = new Set(preferences.dietaryTags);
    if (nextSet.has(id)) {
      nextSet.delete(id);
    } else {
      nextSet.add(id);
    }
    applyPreferences({ dietaryTags: Array.from(nextSet) }, true);
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncView = () => {
      setViewMode(resolveViewFromPath());
    };
    window.addEventListener("popstate", syncView);
    return () => {
      window.removeEventListener("popstate", syncView);
    };
  }, []);

  const navigateView = (mode: ViewMode) => {
    if (typeof window !== "undefined") {
      const nextPath =
        mode === "storefront"
          ? "/search"
          : "/";
      if (window.location.pathname !== nextPath) {
        window.history.pushState({}, "", nextPath);
      }
    }
    setViewMode(mode);
  };

  const renderHeaderControls = () => (
    <div className="flex items-center gap-3">
      <div className="rounded-full bg-primary/20 px-4 py-2 text-sm">
        Health · Savings · Transparency
      </div>
      <div className="flex items-center rounded-full border border-slate-200 overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => navigateView("default")}
          className={`px-3 py-1 transition ${
            viewMode === "default"
              ? "bg-primary-light text-white"
              : "bg-white text-slate-600 hover:bg-slate-100"
          }`}
        >
          Main dashboard
        </button>
        <button
          type="button"
          onClick={() => navigateView("storefront")}
          className={`px-3 py-1 transition border-l border-slate-200 ${
            viewMode === "storefront"
              ? "bg-primary-light text-white"
              : "bg-white text-slate-600 hover:bg-slate-100"
          }`}
        >
          Storefront search
        </button>
      </div>
      <div className="flex items-center rounded-full border border-slate-200 overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => {
            if (policyMode === "semi_managed") return;
            setPolicyMode("semi_managed");
            trigger(query, {
              useBedrock: forceSonnet,
              rerank: true,
              preferences,
              policyMode: "semi_managed",
              useAgentCore,
            });
          }}
          className={`px-3 py-1 transition ${
            policyMode === "semi_managed"
              ? "bg-primary-light text-white"
              : "bg-white text-slate-600 hover:bg-slate-100"
          }`}
        >
          Haiku Semi-managed
        </button>
        <button
          type="button"
          onClick={() => {
            if (policyMode === "fully_managed") return;
            setPolicyMode("fully_managed");
            trigger(query, {
              useBedrock: forceSonnet,
              rerank: true,
              preferences,
              policyMode: "fully_managed",
              useAgentCore,
            });
          }}
          className={`px-3 py-1 transition border-l border-slate-200 ${
            policyMode === "fully_managed"
              ? "bg-primary-light text-white"
              : "bg-white text-slate-600 hover:bg-slate-100"
          }`}
        >
          Haiku Fully-managed
        </button>
      </div>
      <button
        onClick={() => {
          const next = !useAgentCore;
          setUseAgentCore(next);
          trigger(query, {
            rerank: true,
            useBedrock: forceSonnet,
            preferences,
            policyMode,
            useAgentCore: next,
          });
        }}
        className={`rounded-full px-4 py-2 text-sm border transition ${
          useAgentCore
            ? "bg-primary-light text-white border-primary-light"
            : "bg-white text-slate-600 border-slate-200"
        }`}
      >
        {useAgentCore ? "AgentCore: On" : "AgentCore: Off"}
      </button>
      <button
        onClick={() => {
          const next = !forceSonnet;
          setForceSonnet(next);
          trigger(query, {
            useBedrock: next,
            rerank: true,
            preferences,
            policyMode,
            useAgentCore,
          });
        }}
        className={`rounded-full px-4 py-2 text-sm border transition ${
          forceSonnet
            ? "bg-emerald-100 text-emerald-700 border-emerald-200"
            : "bg-white text-slate-600 border-slate-200"
        }`}
      >
        {forceSonnet ? "Force Sonnet: On" : "Force Sonnet: Off"}
      </button>
    </div>
  );

  const renderHeader = () => (
    <header className="px-10 py-6 border-b border-slate-200/80 flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Healthy Basket // Smart Grocery Assistant
        </h1>
        <p className="text-sm text-slate-900/60">
          Powered by Elastic MCP + Amazon Bedrock reasoning.
        </p>
        {viewMode === "storefront" ? (
          <p className="text-xs text-slate-500 mt-1">
            Quick link: {typeof window !== "undefined" ? window.location.origin : ""}/search
          </p>
        ) : null}
      </div>
      {renderHeaderControls()}
    </header>
  );

  const sharedAssistantProps = {
    query,
    data,
    isLoading,
    isError,
  } as const;

  const personalizationWidgets = ["Personalised basket · Dietary & lifestyle filters"];

  useEffect(() => {
    setSearchDraft(query);
  }, [query]);

  const handleStorefrontSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!searchDraft.trim()) return;
    handleSearch(searchDraft.trim());
  };

  if (viewMode === "storefront") {
    return (
      <div className="min-h-screen bg-white text-slate-900 flex flex-col">
        {renderHeader()}
        <main className="flex-1 bg-slate-50">
          <section className="bg-white border-b border-slate-200">
            <div className="px-6 lg:px-10 py-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-semibold text-slate-700">Healthy Basket Market</span>
                  <span>Favorites</span>
                  <span>Lists</span>
                  <span>My points</span>
                </div>
                <div>Language · EN</div>
              </div>
              <form
                onSubmit={handleStorefrontSubmit}
                className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 shadow-sm"
              >
                <div className="flex items-center gap-3 flex-1">
                  <span className="text-slate-400 text-lg">🔍</span>
                  <input
                    value={searchDraft}
                    onChange={(event) => setSearchDraft(event.target.value)}
                    className="flex-1 bg-transparent text-sm text-slate-800 focus:outline-none"
                    placeholder="Search fresh groceries, e.g. tomate"
                  />
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-400 hidden sm:inline">Sorted by relevance</span>
                  <button
                    type="submit"
                    className="rounded-full bg-primary-light px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark transition"
                  >
                    Search
                  </button>
                </div>
              </form>
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
                {personalizationWidgets.map((label) => (
                  <button
                    key={label}
                    type="button"
                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:border-primary-light hover:text-primary-dark transition"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {DIETARY_OPTIONS.map((option) => {
                  const selected = preferences.dietaryTags.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggleDietaryTag(option.id)}
                      className={clsx(
                        "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition",
                        selected
                          ? "border-primary/40 bg-primary/10 text-primary-dark shadow-sm"
                          : "border-slate-200 hover:border-slate-300 text-slate-600"
                      )}
                    >
                      <span className="text-base">{option.emoji}</span>
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="px-6 lg:px-10 py-8">
            <SearchGrid products={data?.products ?? []} isLoading={isLoading} query={query} />
          </section>
        </main>

        <ConversationDock
          conversation={conversation}
          onReplay={handleSearch}
          onClear={() => mutateConversation([])}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white text-slate-900 flex flex-col">
      {renderHeader()}

      <main className="flex-1 grid grid-cols-5 gap-6 px-10 py-8">
        <section className="col-span-2 space-y-6">
          <PreferenceToolbar
            preferences={preferences}
            onChange={handlePreferenceChange}
            disabled={isLoading}
          />
          <IntentComposer
            presets={INTENT_PRESETS}
            onSubmit={handleSearch}
            isLoading={isLoading}
            defaultValue={query}
            effectiveBudget={
              typeof data?.meta?.budgetMaxPrice === "number"
                ? data?.meta?.budgetMaxPrice
                : (data?.meta?.policyDecision?.context?.maxPrice as number | undefined)
            }
          />
          <InsightsPanel
            query={query}
            data={data}
            isLoading={isLoading}
            isError={isError}
            onPresetSelect={handleSearch}
            preferences={preferences}
          />
        </section>

        <section className="col-span-3">
          <AssistantView
            {...sharedAssistantProps}
            onRefresh={() =>
              trigger(query, {
                rerank: true,
                useBedrock: forceSonnet,
                preferences,
                policyMode,
                useAgentCore,
              })
            }
          />
        </section>
      </main>

      <ConversationDock
        conversation={conversation}
        onReplay={handleSearch}
        onClear={() => mutateConversation([])}
      />
    </div>
  );
}
