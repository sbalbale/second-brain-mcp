export const CHARACTER_LIMIT = 25_000;

/** Default/maximum body chunk returned by vault_read; leaves headroom under CHARACTER_LIMIT for frontmatter + metadata. */
export const READ_CHUNK_DEFAULT = 20_000;
export const READ_CHUNK_MAX = 22_000;

/** Per-file body cap inside vault_batch_read so a batch stays under CHARACTER_LIMIT. */
export const BATCH_READ_PER_FILE_MAX = 6_000;

/** wiki_lint_scan flags pages whose file is larger than this (bytes) as "oversized". */
export const OVERSIZED_PAGE_BYTES = 20_000;

export const SERVER_NAME = "second-brain-mcp-server";
export const SERVER_VERSION = "0.1.0";

export const TRASH_DIR = ".trash";

export const WIKI_SUBDIRS = ["sources", "entities", "concepts", "synthesis"] as const;

export const RAW_DIR = "raw";
export const WIKI_DIR = "wiki";
export const OUTPUT_DIR = "output";

export const INDEX_FILE = "wiki/index.md";
export const LOG_FILE = "wiki/log.md";
export const RAG_INDEX_STATUS_FILE = "output/qmd-index-status.json";
