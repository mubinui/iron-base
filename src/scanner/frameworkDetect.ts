import type { Manifest } from "./manifests";

interface Rule {
  name: string;
  deps?: string[];
  files?: RegExp;
}

const RULES: Rule[] = [
  { name: "Express", deps: ["express"] },
  { name: "Fastify", deps: ["fastify"] },
  { name: "NestJS", deps: ["@nestjs/core"] },
  { name: "Koa", deps: ["koa"] },
  { name: "Next.js", deps: ["next"] },
  { name: "React", deps: ["react"] },
  { name: "Vue", deps: ["vue"] },
  { name: "Angular", deps: ["@angular/core"] },
  { name: "Svelte", deps: ["svelte"] },
  { name: "Socket.IO", deps: ["socket.io"] },
  { name: "Mongoose / MongoDB", deps: ["mongoose", "mongodb"] },
  { name: "Prisma", deps: ["prisma", "@prisma/client"] },
  { name: "Sequelize", deps: ["sequelize"] },
  { name: "TypeORM", deps: ["typeorm"] },
  { name: "Knex", deps: ["knex"] },
  { name: "PostgreSQL driver", deps: ["pg", "postgres", "psycopg2", "psycopg2-binary"] },
  { name: "MySQL driver", deps: ["mysql", "mysql2", "pymysql"] },
  { name: "Redis", deps: ["redis", "ioredis"] },
  { name: "BullMQ / job queue", deps: ["bull", "bullmq", "celery", "sidekiq"] },
  { name: "Kafka", deps: ["kafkajs", "kafka-python"] },
  { name: "Elasticsearch", deps: ["@elastic/elasticsearch", "elasticsearch"] },
  { name: "Django", deps: ["django", "Django"], files: /(^|\/)manage\.py$/ },
  { name: "Flask", deps: ["flask", "Flask"] },
  { name: "FastAPI", deps: ["fastapi"] },
  { name: "SQLAlchemy", deps: ["sqlalchemy", "SQLAlchemy"] },
  { name: "Spring Boot", deps: ["spring-boot-starter", "spring-boot-starter-web"] },
  { name: "Ruby on Rails", deps: ["rails"] },
  { name: "Laravel", deps: ["laravel/framework"] },
  { name: "Gin (Go)", deps: ["github.com/gin-gonic/gin"] },
  { name: "Echo (Go)", deps: ["github.com/labstack/echo"] },
  { name: "Actix (Rust)", deps: ["actix-web"] },
  { name: "Axum (Rust)", deps: ["axum"] },
];

const ENTRY_CANDIDATES = [
  /^src\/(index|main|app|server)\.(t|j)sx?$/,
  /^(index|main|app|server)\.(t|j)sx?$/,
  /^src\/main\.py$/,
  /^(main|app|wsgi|asgi)\.py$/,
  /^manage\.py$/,
  /^cmd\/[^/]+\/main\.go$/,
  /^main\.go$/,
  /^src\/main\/java\/.*Application\.java$/,
  /^src\/main\.rs$/,
  /^config\.ru$/,
];

export function detectFrameworks(manifests: Manifest[], paths: string[]): string[] {
  const allDeps = new Set(
    manifests.flatMap((m) => m.dependencies.map((d) => d.toLowerCase())),
  );
  const found: string[] = [];
  for (const rule of RULES) {
    const byDep = rule.deps?.some((d) => allDeps.has(d.toLowerCase()));
    const byFile = rule.files ? paths.some((p) => rule.files!.test(p)) : false;
    if (byDep || byFile) found.push(rule.name);
  }
  return found;
}

export function detectEntryPoints(manifests: Manifest[], paths: string[]): string[] {
  const entries = new Set<string>();
  for (const pattern of ENTRY_CANDIDATES) {
    for (const p of paths) {
      if (pattern.test(p)) entries.add(p);
    }
  }
  for (const manifest of manifests) {
    const start = manifest.scripts?.start;
    if (start) {
      const match = start.match(/([\w./-]+\.(?:[tj]sx?|py|go))/);
      if (match && paths.includes(match[1])) entries.add(match[1]);
    }
  }
  return [...entries].slice(0, 12);
}
