import { SIGNAL_LABELS, type SignalKind } from "./symbols";
import type { FileRecord, WorkspaceIndex } from "./store";

export interface RetrievalHit {
  path: string;
  score: number;
  reasons: string[];
  /** The most relevant concrete lines from this file for the query. */
  excerpts: Array<{ line: number; text: string }>;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "in", "on", "at", "to", "of", "for",
  "and", "or", "but", "if", "how", "what", "where", "which", "does", "do", "this",
  "that", "with", "from", "by", "it", "its", "be", "been", "has", "have", "can",
  "any", "all", "there", "their", "we", "i", "you", "code", "file", "files", "app",
]);

/** Query words that should pull in a whole signal class, not just literal matches. */
const CONCEPT_SIGNALS: Array<{ terms: string[]; kinds: SignalKind[] }> = [
  { terms: ["session", "sessions", "login", "auth", "authentication"], kinds: ["session-handling", "auth-check"] },
  { terms: ["sql", "query", "queries", "database", "db"], kinds: ["raw-sql", "sql-concat", "query-in-loop", "unbounded-query"] },
  { terms: ["n+1", "loop", "loops"], kinds: ["query-in-loop"] },
  { terms: ["secret", "secrets", "key", "keys", "password", "credential", "credentials"], kinds: ["hardcoded-secret", "env-config"] },
  { terms: ["state", "memory", "global", "scale", "scaling", "stateless", "horizontal"], kinds: ["in-memory-state", "session-handling", "local-file-write"] },
  { terms: ["blocking", "sync", "synchronous", "block"], kinds: ["sync-io"] },
  { terms: ["cache", "caching", "redis"], kinds: ["cache-usage"] },
  { terms: ["queue", "job", "jobs", "worker", "background", "async"], kinds: ["queue-usage"] },
  { terms: ["route", "routes", "endpoint", "endpoints", "handler", "handlers", "api"], kinds: ["http-route"] },
  { terms: ["error", "errors", "exception", "exceptions", "failure"], kinds: ["error-handling"] },
  { terms: ["log", "logs", "logging", "observability", "monitoring", "metrics"], kinds: ["logging"] },
  { terms: ["upload", "uploads", "file", "storage", "disk"], kinds: ["local-file-write"] },
  { terms: ["config", "configuration", "environment", "env"], kinds: ["env-config"] },
  { terms: ["external", "http", "network", "third-party", "integration"], kinds: ["external-call"] },
  { terms: ["pagination", "limit", "unbounded"], kinds: ["unbounded-query"] },
];

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Splits camelCase / snake_case / paths into searchable parts. */
function identifierParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 1);
}

/**
 * Ranks files against a natural-language query using the local index.
 *
 * This is what replaces the model grepping the repository. Scoring blends three
 * signals — matches on symbol names, matches on the file path, and matches on the
 * architecture markers found at index time — with an IDF weight so a term that
 * appears everywhere counts for little.
 */
export function retrieve(
  index: WorkspaceIndex,
  query: string,
  limit = 12,
): RetrievalHit[] {
  const records = Object.values(index.files);
  if (records.length === 0) return [];

  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const wantedKinds = new Set<SignalKind>();
  for (const { terms: conceptTerms, kinds } of CONCEPT_SIGNALS) {
    if (conceptTerms.some((t) => terms.includes(t))) {
      for (const kind of kinds) wantedKinds.add(kind);
    }
  }

  const idf = buildIdf(records, terms);
  const hits: RetrievalHit[] = [];

  for (const record of records) {
    let score = 0;
    const reasons: string[] = [];
    const excerpts: Array<{ line: number; text: string }> = [];

    // Path match — a file called `session.js` is a strong hit for "sessions".
    const pathParts = identifierParts(record.path);
    let pathScore = 0;
    for (const term of terms) {
      if (pathParts.includes(term)) pathScore += 3 * (idf.get(term) ?? 1);
    }
    if (pathScore > 0) {
      score += pathScore;
      reasons.push("path matches the query");
    }

    // Symbol-name match, with routes weighted up — they are the request surface.
    let symbolScore = 0;
    const matchedSymbols: string[] = [];
    for (const symbol of record.symbols) {
      const parts = identifierParts(symbol.name);
      for (const term of terms) {
        if (parts.includes(term)) {
          symbolScore += (symbol.kind === "route" ? 3 : 2) * (idf.get(term) ?? 1);
          if (matchedSymbols.length < 4) matchedSymbols.push(symbol.name);
          if (excerpts.length < 3) {
            excerpts.push({ line: symbol.line, text: `${symbol.kind} ${symbol.name}` });
          }
          break;
        }
      }
    }
    if (symbolScore > 0) {
      score += symbolScore;
      reasons.push(`defines ${matchedSymbols.join(", ")}`);
    }

    // Signal match — the concept-level route into the file.
    const kindsHere = new Set(record.signals.map((s) => s.kind));
    const matchedKinds = [...wantedKinds].filter((k) => kindsHere.has(k));
    if (matchedKinds.length > 0) {
      score += 4 * matchedKinds.length;
      reasons.push(
        `contains ${matchedKinds.map((k) => SIGNAL_LABELS[k]).slice(0, 3).join(", ")}`,
      );
      for (const signal of record.signals) {
        if (excerpts.length >= 5) break;
        if (matchedKinds.includes(signal.kind)) {
          excerpts.push({ line: signal.line, text: signal.text });
        }
      }
    }

    // Literal match against the captured signal lines.
    let textScore = 0;
    for (const signal of record.signals) {
      const lower = signal.text.toLowerCase();
      for (const term of terms) {
        if (lower.includes(term)) {
          textScore += 1.5 * (idf.get(term) ?? 1);
          if (excerpts.length < 6 && !excerpts.some((e) => e.line === signal.line)) {
            excerpts.push({ line: signal.line, text: signal.text });
          }
          break;
        }
      }
    }
    score += textScore;

    if (score <= 0) continue;
    // Large files are slightly favoured — in practice they hold more architecture.
    score *= 1 + Math.min(0.35, record.loc / 4000);
    hits.push({
      path: record.path,
      score,
      reasons,
      excerpts: excerpts.sort((a, b) => a.line - b.line).slice(0, 5),
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Inverse document frequency, so ubiquitous terms stop dominating the ranking. */
function buildIdf(records: FileRecord[], terms: string[]): Map<string, number> {
  const idf = new Map<string, number>();
  const total = records.length;
  for (const term of terms) {
    let containing = 0;
    for (const record of records) {
      const inPath = identifierParts(record.path).includes(term);
      const inSymbol =
        !inPath && record.symbols.some((s) => identifierParts(s.name).includes(term));
      if (inPath || inSymbol) containing++;
    }
    idf.set(term, Math.log(1 + total / (1 + containing)));
  }
  return idf;
}

/** All indexed occurrences of one signal kind, newest-largest file first. */
export function signalsOfKind(
  index: WorkspaceIndex,
  kind: SignalKind,
  limit = 40,
): Array<{ path: string; line: number; text: string }> {
  const out: Array<{ path: string; line: number; text: string }> = [];
  for (const record of Object.values(index.files)) {
    for (const signal of record.signals) {
      if (signal.kind === kind) {
        out.push({ path: record.path, line: signal.line, text: signal.text });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

export function countSignals(index: WorkspaceIndex): Map<SignalKind, number> {
  const counts = new Map<SignalKind, number>();
  for (const record of Object.values(index.files)) {
    const seen = new Set<SignalKind>();
    for (const signal of record.signals) {
      if (seen.has(signal.kind)) continue;
      seen.add(signal.kind);
      counts.set(signal.kind, (counts.get(signal.kind) ?? 0) + 1);
    }
  }
  return counts;
}
