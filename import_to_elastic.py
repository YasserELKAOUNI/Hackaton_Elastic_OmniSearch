#!/usr/bin/env python3
"""Bulk-import the Healthy Basket dataset into Elasticsearch."""

import argparse
import json
import os
from pathlib import Path
from typing import Iterable, Iterator, List

import requests

try:
    from dotenv import load_dotenv
except ImportError:  # Optional dependency
    def load_dotenv(*_args, **_kwargs):
        """Fallback when python-dotenv isn't installed."""
        return False

load_dotenv()

# Replace hardcoded placeholder with env-driven config (no secret defaults)
DEFAULT_ES_URL = os.getenv("ES_URL")  # require setting in .env or CLI
DEFAULT_API_KEY = os.getenv("ELASTIC_API_KEY")

DEFAULT_PRODUCTS_INDEX = "healthy-basket-products"
DEFAULT_PROMOTIONS_INDEX = "healthy-basket-promotions"
DEFAULT_CHUNK_SIZE = 500
DEFAULT_TIMEOUT = 60


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import Healthy Basket products and promotions via the Elasticsearch _bulk API."
    )
    parser.add_argument(
        "--dataset-path",
        default="data/healthy_basket_dataset.json",
        help="Path to the dataset JSON file.",
    )
    parser.add_argument(
        "--es-url",
        default=os.getenv("ES_URL", DEFAULT_ES_URL),
        help="Elasticsearch endpoint (protocol + host) or set ES_URL in .env.",
    )
    parser.add_argument(
        "--api-key",
        default=os.getenv("ELASTIC_API_KEY", DEFAULT_API_KEY),
        help="Elasticsearch API key (or set ELASTIC_API_KEY in env/.env).",
    )
    parser.add_argument(
        "--products-index",
        "--index-name",
        default=DEFAULT_PRODUCTS_INDEX,
        help="Index name for product documents (alias: --index-name).",
    )
    parser.add_argument(
        "--promotions-index",
        default=DEFAULT_PROMOTIONS_INDEX,
        help="Index name for promotion documents.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=DEFAULT_CHUNK_SIZE,
        help="Number of documents per _bulk request.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help="HTTP request timeout in seconds.",
    )
    parser.add_argument(
        "--skip-promotions",
        action="store_true",
        help="Only import products (ignore promotions section).",
    )
    return parser.parse_args()


def load_dataset(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Dataset file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in dataset file: {exc}") from exc


def make_bulk_lines(actions: Iterable[dict], index_name: str) -> Iterator[str]:
    for doc in actions:
        doc_id = doc.get("product_id") or doc.get("promotion_id")
        meta = {"index": {"_index": index_name}}
        if doc_id:
            meta["index"]["_id"] = doc_id
        yield json.dumps(meta, ensure_ascii=False)
        yield json.dumps(doc, ensure_ascii=False)


def chunked(iterable: Iterable[str], size: int) -> Iterator[List[str]]:
    chunk: List[str] = []
    for line in iterable:
        chunk.append(line)
        if len(chunk) >= size * 2:  # two lines per document
            yield chunk
            chunk = []
    if chunk:
        yield chunk


def send_bulk(es_url: str, api_key: str, lines: List[str], timeout: int) -> dict:
    endpoint = f"{es_url.rstrip('/')}/_bulk"
    data = "\n".join(lines) + "\n"
    headers = {
        "Content-Type": "application/x-ndjson",
        "Authorization": f"ApiKey {api_key}",
    }
    response = requests.post(endpoint, headers=headers, data=data.encode("utf-8"), timeout=timeout)
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        raise SystemExit(f"Bulk request failed: {exc}\n{response.text}") from exc
    return response.json()


def import_documents(dataset: dict, es_url: str, api_key: str, products_index: str, promotions_index: str,
                     chunk_size: int, timeout: int, skip_promotions: bool) -> None:
    products = dataset.get("products", [])
    promotions = dataset.get("promotions", []) if not skip_promotions else []

    product_lines = list(make_bulk_lines(products, products_index))
    promotion_lines = list(make_bulk_lines(promotions, promotions_index)) if promotions else []

    batches_sent = 0
    errors = []

    for batch in chunked(product_lines, chunk_size):
        result = send_bulk(es_url, api_key, batch, timeout)
        batches_sent += 1
        errors.extend(result.get("items", []))

    for batch in chunked(promotion_lines, chunk_size):
        result = send_bulk(es_url, api_key, batch, timeout)
        batches_sent += 1
        errors.extend(result.get("items", []))

    failed = [item for item in errors if item.get("index", {}).get("error")]
    print(f"Bulk import finished. Batches sent: {batches_sent}.")
    if failed:
        print(f"Documents with errors: {len(failed)}")
        print(json.dumps(failed[:5], indent=2, ensure_ascii=False))
    else:
        print("All documents indexed without reported errors.")


def main() -> None:
    args = parse_args()
    dataset = load_dataset(Path(args.dataset_path))
    if not args.api_key:
        raise SystemExit("API key is required. Provide via --api-key or ELASTIC_API_KEY env var.")

    import_documents(
        dataset=dataset,
        es_url=args.es_url,
        api_key=args.api_key,
        products_index=args.products_index,
        promotions_index=args.promotions_index,
        chunk_size=args.chunk_size,
        timeout=args.timeout,
        skip_promotions=args.skip_promotions,
    )


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as exc:
        raise SystemExit(f"Network error during import: {exc}") from exc
