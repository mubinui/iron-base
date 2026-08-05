import * as vscode from "vscode";
import type { AnalysisReport, Severity } from "../engine/findings";

/**
 * Findings are advisory, so they never use DiagnosticSeverity.Error — that is
 * reserved for things that actually break the build.
 */
const SEVERITY_MAP: Record<Severity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Warning,
  high: vscode.DiagnosticSeverity.Warning,
  medium: vscode.DiagnosticSeverity.Information,
  low: vscode.DiagnosticSeverity.Hint,
  info: vscode.DiagnosticSeverity.Hint,
};

export class DiagnosticsPublisher {
  private readonly collection: vscode.DiagnosticCollection;

  constructor(context: vscode.ExtensionContext) {
    this.collection = vscode.languages.createDiagnosticCollection("ironbase");
    context.subscriptions.push(this.collection);
  }

  clear(): void {
    this.collection.clear();
  }

  publish(root: vscode.Uri, report: AnalysisReport): void {
    this.collection.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const finding of report.findings) {
      for (const evidence of finding.evidence) {
        const line = Math.max(0, (evidence.startLine ?? 1) - 1);
        const endLine = Math.max(line, (evidence.endLine ?? evidence.startLine ?? 1) - 1);
        const range = new vscode.Range(line, 0, endLine, Number.MAX_SAFE_INTEGER);

        const diagnostic = new vscode.Diagnostic(
          range,
          `${finding.title}\n\n${finding.explanation}\n\nFix: ${finding.recommendation}`,
          SEVERITY_MAP[finding.severity],
        );
        diagnostic.source = "ironbase";
        diagnostic.code = finding.category;

        const list = byFile.get(evidence.file) ?? [];
        list.push(diagnostic);
        byFile.set(evidence.file, list);
      }
    }

    for (const [file, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.joinPath(root, ...file.split("/")), diagnostics);
    }
  }
}
