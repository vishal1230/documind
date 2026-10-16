"""Download and load the local models once, e.g. while building the Docker image.

    python -m app.warmup

Without this, the first upload or question would wait ~30 s for the download.
"""

from app.models import get_embedder, get_reranker

if __name__ == "__main__":
    vec = get_embedder().embed_query("warm up")
    print(f"embedder ready ({len(vec)} dimensions)")
    reranker = get_reranker()
    if reranker:
        reranker.score("warm up", ["warm up"])
        print("re-ranker ready")
