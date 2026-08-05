export interface Manifest {
  file: string;
  ecosystem: string;
  dependencies: string[];
  scripts?: Record<string, string>;
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "Cargo.toml",
]);

const INFRA_NAMES = new Set([
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Procfile",
  "serverless.yml",
  "serverless.yaml",
  "vercel.json",
  "netlify.toml",
  "fly.toml",
  "nginx.conf",
  "Makefile",
]);

export function isManifest(fileName: string): boolean {
  return MANIFEST_NAMES.has(fileName);
}

export function isInfraFile(fileName: string, relPath: string): boolean {
  if (INFRA_NAMES.has(fileName)) return true;
  if (fileName.startsWith("Dockerfile")) return true;
  if (/(^|\/)(k8s|kubernetes|helm|deploy|manifests)\//i.test(relPath)) {
    return /\.(ya?ml)$/i.test(fileName);
  }
  if (/(^|\/)\.github\/workflows\//.test(relPath)) return true;
  return false;
}

export function parseManifest(relPath: string, content: string): Manifest | undefined {
  const fileName = relPath.split("/").pop() ?? relPath;
  try {
    switch (fileName) {
      case "package.json":
        return parsePackageJson(relPath, content);
      case "requirements.txt":
        return {
          file: relPath,
          ecosystem: "python",
          dependencies: content
            .split(/\r?\n/)
            .map((l) => l.split("#")[0].trim())
            .filter((l) => l.length > 0 && !l.startsWith("-")),
        };
      case "pyproject.toml":
      case "Pipfile":
        return {
          file: relPath,
          ecosystem: "python",
          dependencies: extractTomlishNames(content),
        };
      case "go.mod":
        return {
          file: relPath,
          ecosystem: "go",
          dependencies: [...content.matchAll(/^\s+([\w.\-/]+)\s+v[\w.\-+]+/gm)].map(
            (m) => m[1],
          ),
        };
      case "pom.xml":
        return {
          file: relPath,
          ecosystem: "java",
          dependencies: [
            ...content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g),
          ].map((m) => m[1]),
        };
      case "build.gradle":
      case "build.gradle.kts":
        return {
          file: relPath,
          ecosystem: "java",
          dependencies: [
            ...content.matchAll(/["']([\w.\-]+:[\w.\-]+)(?::[\w.\-]+)?["']/g),
          ].map((m) => m[1]),
        };
      case "Gemfile":
        return {
          file: relPath,
          ecosystem: "ruby",
          dependencies: [...content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map(
            (m) => m[1],
          ),
        };
      case "composer.json": {
        const json = JSON.parse(content);
        return {
          file: relPath,
          ecosystem: "php",
          dependencies: Object.keys(json.require ?? {}),
        };
      }
      case "Cargo.toml":
        return {
          file: relPath,
          ecosystem: "rust",
          dependencies: extractTomlishNames(content),
        };
      default:
        return undefined;
    }
  } catch {
    return { file: relPath, ecosystem: "unknown", dependencies: [] };
  }
}

function parsePackageJson(relPath: string, content: string): Manifest {
  const json = JSON.parse(content);
  return {
    file: relPath,
    ecosystem: "node",
    dependencies: [
      ...Object.keys(json.dependencies ?? {}),
      ...Object.keys(json.devDependencies ?? {}),
    ],
    scripts: json.scripts ?? undefined,
  };
}

/** Loose name extraction that works for both TOML tables and dependency lists. */
function extractTomlishNames(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(/^\s*["']?([A-Za-z][\w.\-]*)["']?\s*=/gm)) {
    names.add(match[1]);
  }
  for (const match of content.matchAll(/["']([A-Za-z][\w.\-]*)\s*[><=~^]{1,2}/g)) {
    names.add(match[1]);
  }
  return [...names];
}
