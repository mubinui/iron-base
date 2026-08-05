/**
 * Local, dependency-free structural extraction.
 *
 * The point of this module is to do the expensive reading **once**, on the user's
 * machine, at zero token cost — so the model never has to grep blindly through the
 * repository to find where the interesting things are. What comes out is a small
 * structural fingerprint per file: the symbols it declares, what it imports, and
 * the architecture-relevant signals it carries.
 */

export type SymbolKind = "function" | "class" | "method" | "route" | "model" | "config";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
}

/** Architecture-relevant markers detected without a model. */
export type SignalKind =
  | "http-route"
  | "raw-sql"
  | "sql-concat"
  | "query-in-loop"
  | "unbounded-query"
  | "in-memory-state"
  | "session-handling"
  | "sync-io"
  | "local-file-write"
  | "hardcoded-secret"
  | "env-config"
  | "cache-usage"
  | "queue-usage"
  | "external-call"
  | "error-handling"
  | "logging"
  | "auth-check"
  | "test";

export const SIGNAL_LABELS: Record<SignalKind, string> = {
  "http-route": "HTTP route handlers",
  "raw-sql": "raw SQL statements",
  "sql-concat": "SQL built by string concatenation",
  "query-in-loop": "database queries inside loops",
  "unbounded-query": "queries with no LIMIT or pagination",
  "in-memory-state": "module-level mutable state",
  "session-handling": "session handling",
  "sync-io": "synchronous or blocking I/O",
  "local-file-write": "writes to the local filesystem",
  "hardcoded-secret": "credentials that look hardcoded",
  "env-config": "environment-variable configuration",
  "cache-usage": "caching",
  "queue-usage": "background jobs or queues",
  "external-call": "outbound network calls",
  "error-handling": "error handling",
  logging: "logging",
  "auth-check": "authorization checks",
  test: "tests",
};

/** Signals that usually indicate a problem, surfaced first in the digest. */
export const RISK_SIGNALS: SignalKind[] = [
  "hardcoded-secret",
  "sql-concat",
  "query-in-loop",
  "in-memory-state",
  "sync-io",
  "unbounded-query",
  "local-file-write",
];

export interface Signal {
  kind: SignalKind;
  line: number;
  text: string;
}

export interface FileStructure {
  symbols: CodeSymbol[];
  imports: string[];
  signals: Signal[];
  loc: number;
}

interface Pattern {
  kind: SignalKind;
  re: RegExp;
}

const SIGNAL_PATTERNS: Pattern[] = [
  // Routing across the common frameworks.
  {
    kind: "http-route",
    re: /\b(?:app|router|server|api)\.(?:get|post|put|patch|delete|all|use)\s*\(\s*["'`]/i,
  },
  { kind: "http-route", re: /@(?:app|blueprint|bp)\.route\s*\(/i },
  { kind: "http-route", re: /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b/ },
  { kind: "http-route", re: /@(?:Get|Post|Put|Patch|Delete)\s*\(/ },
  { kind: "http-route", re: /\b(?:r|router|mux)\.(?:HandleFunc|GET|POST|PUT|DELETE)\s*\(/ },

  // Data access. Concatenated SQL is checked before plain SQL: the first match
  // wins, and injection-shaped SQL is the more important of the two.
  {
    kind: "sql-concat",
    // A SQL keyword on the line, plus a concatenation or interpolation marker.
    // Written as a lookahead so a quote inside the string literal — which is the
    // normal case for `WHERE email = '" + email + "'` — doesn't break the match.
    re: /(?=.*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES|SET)\b).*(?:["'`]\s*\+|\+\s*["'`]|\$\{|%\s*\()/i,
  },
  {
    kind: "raw-sql",
    re: /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[\s\S]{0,80}?\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i,
  },
  {
    kind: "unbounded-query",
    re: /\bSELECT\s+\*\s+FROM\b(?![\s\S]{0,120}\bLIMIT\b)/i,
  },
  { kind: "unbounded-query", re: /\.(?:findAll|find)\s*\(\s*\)|\.objects\.all\s*\(\s*\)/ },

  // State and scaling hazards.
  {
    kind: "in-memory-state",
    re: /^(?:const|let|var)\s+\w+\s*(?::\s*[^=]+)?=\s*(?:\{\s*\}|\[\s*\]|new\s+(?:Map|Set|WeakMap)\s*\(\s*\))\s*;?\s*$/,
  },
  { kind: "session-handling", re: /\bsessions?\b\s*[[.=]|\bexpress-session\b|\breq\.session\b|\bsession\[/i },
  { kind: "sync-io", re: /\b(?:readFileSync|writeFileSync|appendFileSync|existsSync|readdirSync|execSync|spawnSync|renameSync|unlinkSync)\b/ },
  { kind: "sync-io", re: /\btime\.sleep\s*\(|\bThread\.sleep\s*\(/ },
  { kind: "local-file-write", re: /\b(?:multer|diskStorage|writeFile|createWriteStream|save_to_disk)\b|\bdest\s*:\s*["'`]/ },

  // Configuration and secrets.
  {
    kind: "hardcoded-secret",
    // The leading `[\w$.]*` is load-bearing: `_` is a word character, so a `\b`
    // here would never fire inside `STRIPE_API_KEY` or `DB_PASSWORD` — which is
    // the shape most real hardcoded credentials actually take.
    re: /[\w$.]*(?:api[_-]?key|apikey|secret|password|passwd|token|private[_-]?key|access[_-]?key|credentials?)\s*[:=]\s*["'`][^"'`\s{$][^"'`]{6,}["'`]/i,
  },
  { kind: "hardcoded-secret", re: /["'`](?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}["'`]|["'`]AKIA[0-9A-Z]{12,}["'`]|["'`]gh[pousr]_[A-Za-z0-9]{20,}["'`]/ },
  { kind: "env-config", re: /\bprocess\.env\b|\bos\.environ\b|\bENV\[|\bgetenv\s*\(|\bSystem\.getenv\b/ },

  // Infrastructure the app leans on.
  { kind: "cache-usage", re: /\b(?:redis|memcached|ioredis|node-cache|lru-cache|@cacheable|cache\.(?:get|set))\b/i },
  { kind: "queue-usage", re: /\b(?:bull|bullmq|celery|sidekiq|rabbitmq|amqp|kafka|sqs|pubsub|worker_threads)\b/i },
  { kind: "external-call", re: /\b(?:fetch|axios|got|request|httpx|requests\.(?:get|post)|HttpClient|urllib)\s*[.(]/ },

  // Operational maturity.
  { kind: "error-handling", re: /\b(?:try\s*\{|except\b|rescue\b|catch\s*\(|\.catch\s*\(|errors\.Is\b|if\s+err\s*!=\s*nil)/ },
  { kind: "logging", re: /\b(?:console\.(?:log|error|warn)|logger?\.(?:info|warn|error|debug)|print\s*\(|log\.(?:Print|Info|Error))/ },
  { kind: "auth-check", re: /\b(?:authenticate|authorize|isAuthenticated|requireAuth|checkPermission|@login_required|ensureLoggedIn|verifyToken|jwt\.verify)\b/i },
  { kind: "test", re: /\b(?:describe|it|test|expect)\s*\(|\bdef\s+test_|\bfunc\s+Test[A-Z]|@Test\b/ },
];

const SYMBOL_PATTERNS: Array<{ kind: SymbolKind; re: RegExp; group: number }> = [
  { kind: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, group: 1 },
  { kind: "class", re: /^\s*(?:public\s+|internal\s+)?(?:sealed\s+|abstract\s+)?(?:class|interface|struct|record)\s+([A-Za-z_$][\w$]*)/, group: 1 },
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, group: 1 },
  { kind: "function", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, group: 1 },
  { kind: "function", re: /^\s*def\s+([A-Za-z_][\w]*)/, group: 1 },
  { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, group: 1 },
  { kind: "function", re: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/, group: 1 },
  { kind: "method", re: /^\s{2,}(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, group: 1 },
  { kind: "model", re: /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(?:mongoose\.model|sequelize\.define|new\s+Schema)/, group: 1 },
  { kind: "model", re: /^\s*class\s+([A-Za-z_][\w]*)\s*\(\s*(?:models\.Model|db\.Model|Base)\s*\)/, group: 1 },
];

const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/,
  /^\s*(?:const|let|var)\s+.*?=\s*require\s*\(\s*["']([^"']+)["']\s*\)/,
  /^\s*from\s+([\w.]+)\s+import\b/,
  /^\s*import\s+([\w.]+)\s*$/,
  /^\s*use\s+([\w:]+)\s*;/,
  /^\s*#include\s*[<"]([^>"]+)[>"]/,
];

const ROUTE_PATH = /["'`]([/][^"'`]*)["'`]/;
const LOOP_START = /\b(?:for|forEach|while|map\s*\(|\.each\b)\b/;

const MAX_LINES = 6000;
const MAX_SIGNALS_PER_KIND = 12;
const MAX_SYMBOLS = 80;

/**
 * Extracts structure from one file. Runs on every changed file, so it stays
 * single-pass and regex-only — no AST parsing, no dependencies.
 */
export function extractStructure(content: string): FileStructure {
  const lines = content.split(/\r?\n/);
  const capped = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines;

  const symbols: CodeSymbol[] = [];
  const imports = new Set<string>();
  const signals: Signal[] = [];
  const perKind = new Map<SignalKind, number>();

  // Tracks how many lines remain inside the most recent loop body, so a query
  // inside it can be flagged as a likely N+1 without parsing scopes properly.
  let loopBudget = 0;

  for (let i = 0; i < capped.length; i++) {
    const line = capped[i];
    if (line.length > 500) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (LOOP_START.test(line)) loopBudget = 12;
    else if (loopBudget > 0) loopBudget--;

    for (const re of IMPORT_PATTERNS) {
      const match = re.exec(line);
      if (match) {
        imports.add(match[1]);
        break;
      }
    }

    if (symbols.length < MAX_SYMBOLS) {
      for (const { kind, re, group } of SYMBOL_PATTERNS) {
        const match = re.exec(line);
        if (match?.[group] && !isNoiseSymbol(match[group])) {
          symbols.push({ name: match[group], kind, line: i + 1 });
          break;
        }
      }
    }

    for (const { kind, re } of SIGNAL_PATTERNS) {
      if (!re.test(line)) continue;
      const seen = perKind.get(kind) ?? 0;
      if (seen >= MAX_SIGNALS_PER_KIND) continue;
      perKind.set(kind, seen + 1);
      signals.push({ kind, line: i + 1, text: trimmed.slice(0, 160) });

      if (kind === "http-route") {
        const path = ROUTE_PATH.exec(line);
        if (path && symbols.length < MAX_SYMBOLS) {
          symbols.push({ name: path[1], kind: "route", line: i + 1 });
        }
      }
      // A data call inside a loop body is the N+1 shape worth surfacing.
      if ((kind === "raw-sql" || kind === "sql-concat") && loopBudget > 0) {
        const nSeen = perKind.get("query-in-loop") ?? 0;
        if (nSeen < MAX_SIGNALS_PER_KIND) {
          perKind.set("query-in-loop", nSeen + 1);
          signals.push({ kind: "query-in-loop", line: i + 1, text: trimmed.slice(0, 160) });
        }
      }
      break;
    }
  }

  return {
    symbols,
    imports: [...imports].slice(0, 60),
    signals,
    loc: lines.length,
  };
}

const NOISE = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "constructor",
  "get", "set", "then", "map", "filter", "forEach", "require", "module", "exports",
  "main", "init", "new", "await", "async", "class", "def", "func", "var", "let", "const",
]);

function isNoiseSymbol(name: string): boolean {
  return name.length < 2 || NOISE.has(name);
}
