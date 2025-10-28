import { useMemo } from "react";
import { Product } from "../lib/types";

type SearchGridProps = {
  products: Product[];
  isLoading: boolean;
  query: string;
};

const skeletonCards = Array.from({ length: 12 }, (_, index) => index);

function formatSize(product: Product): string | null {
  const packaging = product.packaging as
    | {
        net_weight_kg?: number;
        net_volume_l?: number;
        serving_size?: string;
      }
    | undefined;
  if (!packaging) return null;
  if (typeof packaging.net_weight_kg === "number") {
    return `${Math.round(packaging.net_weight_kg * 1000)} g`;
  }
  if (typeof packaging.net_volume_l === "number") {
    return `${Math.round(packaging.net_volume_l * 1000)} ml`;
  }
  if (typeof packaging.serving_size === "string") {
    return packaging.serving_size;
  }
  return null;
}

function formatPrice(value?: number | null): string {
  if (typeof value !== "number") return "–";
  return `€${value.toFixed(2)}`;
}

function nutriBadge(product: Product): string | null {
  const score = product.nutrition?.nutri_score;
  if (typeof score === "string" && score.length === 1) {
    return score.toUpperCase();
  }
  return null;
}

function SearchTile({ product }: { product: Product }) {
  const label = product.labels?.[0] ?? null;
  const secondaryLabel = product.labels?.[1] ?? null;
  const price = product.price ?? product.pricing?.current_price ?? null;
  const regularPrice = product.regularPrice ?? product.pricing?.regular_price ?? null;
  const pricePerUnit = product.pricing?.price_per_unit;
  const size = formatSize(product);
  const nutri = nutriBadge(product);
  const hasDiscount =
    typeof price === "number" && typeof regularPrice === "number" && price < regularPrice;

  return (
    <article className="flex flex-col rounded-2xl border border-slate-200 bg-white shadow-sm hover:shadow-md transition"> 
      <div className="flex items-center justify-between px-4 pt-4">
        <div className="flex flex-wrap gap-2">
          {label ? (
            <span className="badge bg-rose-50 text-rose-600 border border-rose-100 text-xs">
              {label}
            </span>
          ) : null}
          {secondaryLabel ? (
            <span className="badge bg-emerald-50 text-emerald-600 border border-emerald-100 text-xs">
              {secondaryLabel}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="text-slate-400 hover:text-primary transition"
          aria-label="Add to favourites"
        >
          ♥
        </button>
      </div>

      <div className="mt-3 flex-1 px-4">
        <div className="flex items-center justify-center h-32 bg-slate-100 rounded-xl text-slate-400 text-sm">
          Image unavailable
        </div>
        <div className="mt-4 space-y-1">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {product.brand || "Healthy Basket"}
          </p>
          <h3 className="text-sm font-semibold text-slate-900 leading-tight line-clamp-2">
            {product.name || product.keyword || "Product"}
          </h3>
          <div className="text-xs text-slate-500">
            {size ? <span>{size}</span> : null}
            {pricePerUnit?.value ? (
              <span className="ml-2">{pricePerUnit.value.toFixed(2)} {pricePerUnit.unit}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="px-4 pb-4 pt-3 space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold text-slate-900">{formatPrice(price)}</span>
          {hasDiscount ? (
            <span className="text-xs text-slate-400 line-through">{formatPrice(regularPrice)}</span>
          ) : null}
        </div>
        <div className="flex items-center justify-between text-xs text-slate-500">
          {nutri ? (
            <span className="inline-flex items-center gap-1">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 font-semibold">
                {nutri}
              </span>
              Nutri-score
            </span>
          ) : (
            <span />
          )}
          {product.use_cases?.length ? (
            <span className="truncate" title={product.use_cases.join(", ")}>
              {product.use_cases[0]}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {hasDiscount ? (
            <span className="badge bg-amber-100 text-amber-700 text-xs">Promo</span>
          ) : null}
          {product.loyalty?.eligible ? (
            <span className="badge bg-primary-light/10 text-primary-dark text-xs">
              +{product.loyalty.points ?? 0} pts
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="w-full rounded-xl bg-primary-light px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark transition"
        >
          Add to basket
        </button>
      </div>
    </article>
  );
}

export function SearchGrid({ products, isLoading, query }: SearchGridProps) {
  const resultHeading = useMemo(() => {
    if (isLoading) return "Loading results…";
    if (!products.length) return `No items found for “${query || ""}"`;
    return `${products.length} product${products.length === 1 ? "" : "s"} for “${query || ""}"`;
  }, [isLoading, products.length, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">{resultHeading}</h2>
        {products.length ? (
          <span className="text-xs text-slate-500">Sorted by relevance · Powered by Healthy Basket</span>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {isLoading
          ? skeletonCards.map((key) => (
              <div
                key={key}
                className="h-72 rounded-2xl border border-slate-200 bg-slate-100 animate-pulse"
              />
            ))
          : products.map((product) => (
              <SearchTile
                key={product.product_id ?? product.productId ?? product.sku ?? product.name ?? Math.random().toString(36)}
                product={product}
              />
            ))}
      </div>
    </div>
  );
}
