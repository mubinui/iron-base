import * as vscode from "vscode";
import { AuthManager } from "./auth/authManager";
import { getConfig, getGoogleClient } from "./config";
import { runAnalysis, type ProgressEvent } from "./engine/agentLoop";
import type { AnalysisReport } from "./engine/findings";
import type { RunMode } from "./engine/prompts";
import {
  LlmCancelledError,
  LlmHttpError,
  MODEL_CHOICES,
  PROVIDER_LABELS,
  type LlmClient,
  type ProviderId,
} from "./llm/types";
import { buildDigest } from "./memory/digest";
import { updateIndex } from "./memory/indexer";
import { IndexStore, rememberFindings } from "./memory/store";
import { scanWorkspace } from "./scanner/workspaceScanner";
import { DiagnosticsPublisher } from "./report/diagnostics";
import { exportReport } from "./report/markdownExport";
import { ReportPanel } from "./report/reportPanel";
import { SidebarView } from "./report/sidebarView";
import { describeError, initLog, log } from "./util/log";

let auth: AuthManager;
let sidebar: SidebarView;
let diagnostics: DiagnosticsPublisher;
let statusBar: vscode.StatusBarItem;
let extensionUri: vscode.Uri;
let indexStore: IndexStore;
let lastReport: AnalysisReport | undefined;
let lastRoot: vscode.Uri | undefined;
let activeRun: vscode.CancellationTokenSource | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  log.info("IronBase activated.");

  extensionUri = context.extensionUri;
  indexStore = new IndexStore(context.globalStorageUri);
  auth = new AuthManager(context);
  sidebar = new SidebarView();
  diagnostics = new DiagnosticsPublisher(context);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "ironbase.sidebar.focus";
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarView.viewType, sidebar),
    auth.onDidChange(() => void refreshAuthState()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ironbase")) void refreshAuthState();
    }),
    register("ironbase.analyze", () => startRun({ kind: "review" })),
    register("ironbase.scalabilityCheck", startScalabilityCheck),
    register("ironbase.signInAnthropic", signInAnthropic),
    register("ironbase.signInGoogle", signInGoogle),
    register("ironbase.signInOpenAi", signInOpenAi),
    register("ironbase.chooseModel", chooseModel),
    register("ironbase.clearIndex", clearIndex),
    register("ironbase.signOut", signOut),
    register("ironbase.cancel", cancelRun),
    register("ironbase.exportReport", doExport),
    register("ironbase.showReport", showReport),
    register("ironbase.dev.dumpRepoMap", dumpRepoMap),
    register("ironbase.dev.ping", pingModel),
  );

  void refreshAuthState();
}

export function deactivate(): void {
  activeRun?.cancel();
}

function register(command: string, handler: () => Promise<void> | void): vscode.Disposable {
  return vscode.commands.registerCommand(command, async () => {
    try {
      await handler();
    } catch (err) {
      await reportError(err);
    }
  });
}

async function refreshAuthState(): Promise<void> {
  const client = await auth.getActiveClient();
  const label = client ? PROVIDER_LABELS[client.id] : undefined;
  sidebar.setState({
    providerLabel: label,
    model: client ? describeModel(client) : undefined,
  });
  statusBar.text = `$(pulse) IronBase: ${label ?? "sign in"}`;
  statusBar.tooltip = client
    ? `IronBase is using ${label} (${client.model})`
    : "IronBase — click to connect an AI account";
  statusBar.show();
}

/** Names the resolved model the way the picker lists it, so the two agree. */
function describeModel(client: LlmClient): { label: string; automatic: boolean } {
  const known = MODEL_CHOICES[client.id].find((choice) => choice.id === client.model);
  return {
    label: known?.label ?? client.model,
    automatic: getConfig().model.length === 0,
  };
}

// --- Analysis runs ---------------------------------------------------------

async function startScalabilityCheck(): Promise<void> {
  const target = await vscode.window.showInputBox({
    title: "Scalability Check",
    prompt: "How many users do you want this application to serve?",
    placeHolder: "e.g. 10,000 concurrent users",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? "Describe the load you want to support." : undefined,
  });
  if (!target) return;
  await startRun({ kind: "scalability", target: target.trim() });
}

async function startRun(mode: RunMode): Promise<void> {
  if (activeRun) {
    void vscode.window.showInformationMessage(
      "IronBase is already reviewing this workspace.",
    );
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage(
      "IronBase needs an open folder to review. Open your project first.",
    );
    return;
  }

  const client = await auth.getActiveClient();
  if (!client) {
    sidebar.reveal();
    const choice = await vscode.window.showWarningMessage(
      "Connect the AI account you already have, and IronBase will use it to review your code.",
      "Claude",
      "ChatGPT",
      "Gemini",
    );
    if (choice === "Claude") await signInAnthropic();
    else if (choice === "ChatGPT") await signInOpenAi();
    else if (choice === "Gemini") await signInGoogle();
    return;
  }

  const config = getConfig();
  const source = new vscode.CancellationTokenSource();
  activeRun = source;
  lastRoot = folder.uri;
  sidebar.reveal();
  const runStartedAt = Date.now();
  let lastUsage: { inputTokens: number; outputTokens: number; budget: number } | undefined;
  sidebar.setState({
    running: true,
    findingCount: 0,
    activity: "Scanning workspace…",
    startedAt: runStartedAt,
    usage: undefined,
  });
  statusBar.text = "$(sync~spin) IronBase: reviewing…";

  let findingCount = 0;
  const onProgress = (event: ProgressEvent): void => {
    switch (event.type) {
      case "text":
        sidebar.appendText(event.delta);
        break;
      case "tool":
        sidebar.noteTool(event.name);
        break;
      case "iteration":
        sidebar.setState({ iteration: { current: event.current, max: event.max } });
        statusBar.text = `$(sync~spin) IronBase: step ${event.current}/${event.max}`;
        break;
      case "finding":
        findingCount++;
        sidebar.setState({ findingCount });
        break;
      case "usage":
        lastUsage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          budget: event.budget,
        };
        sidebar.setState({ usage: lastUsage });
        break;
      case "warning":
        sidebar.noteWarning(event.text);
        log.warn(event.text);
        break;
      case "status":
        sidebar.setState({ activity: event.text });
        break;
    }
  };

  try {
    const scan = await scanWorkspace(
      folder,
      { maxFiles: config.maxFiles, ignoreGlobs: config.ignoreGlobs },
      source.token,
    );
    if (source.token.isCancellationRequested) return;
    if (scan.files.length === 0) {
      void vscode.window.showWarningMessage(
        "IronBase found no source files to review in this folder.",
      );
      return;
    }
    log.info(`Scanned ${scan.files.length} files in ${folder.name}.`);

    // Bring the local index up to date. Only files whose content changed since
    // the last run are re-read, so repeat reviews start almost instantly.
    sidebar.setState({ activity: "Updating the project index…" });
    const index = await indexStore.load(folder.uri, folder.name);
    const stats = await updateIndex(index, scan, source.token, (done, total) => {
      sidebar.setState({ activity: `Indexing ${done} of ${total} files…` });
    });
    if (source.token.isCancellationRequested) return;
    await indexStore.save(index);
    sidebar.setState({
      activity:
        stats.reused > 0
          ? `Reused ${stats.reused} cached files, re-read ${stats.reindexed}.`
          : "Reviewing architecture…",
    });

    const report = await runAnalysis({
      client,
      scan,
      index,
      mode,
      config,
      token: source.token,
      onProgress,
    });

    // Remember this run's findings so the next review can tell what was fixed.
    rememberFindings(index, report.findings, report.grade);
    await indexStore.save(index);

    lastReport = report;
    if (config.enableDiagnostics) {
      diagnostics.publish(folder.uri, report);
    } else {
      diagnostics.clear();
    }
    ReportPanel.show(extensionUri, report, folder.uri);
    sidebar.setState({
      lastSummary: {
        grade: report.grade,
        summary: report.summary,
        findingCount: report.findings.length,
        elapsedMs: Date.now() - runStartedAt,
        totalTokens: lastUsage
          ? lastUsage.inputTokens + lastUsage.outputTokens
          : undefined,
      },
    });
    log.info(`Review finished: grade ${report.grade}, ${report.findings.length} findings.`);
  } catch (err) {
    if (err instanceof LlmCancelledError || source.token.isCancellationRequested) {
      log.info("Review cancelled.");
    } else {
      await reportError(err);
    }
  } finally {
    activeRun = undefined;
    source.dispose();
    sidebar.setState({
      running: false,
      activity: undefined,
      iteration: undefined,
      startedAt: undefined,
    });
    await refreshAuthState();
  }
}

function cancelRun(): void {
  if (!activeRun) {
    void vscode.window.showInformationMessage("No IronBase review is running.");
    return;
  }
  activeRun.cancel();
  void vscode.window.showInformationMessage("Cancelling the review…");
}

// --- Auth commands ---------------------------------------------------------

async function signInAnthropic(): Promise<void> {
  if (getConfig().disabledProviders.includes("anthropic-oauth")) {
    void vscode.window.showWarningMessage(
      "Claude account sign-in is disabled in settings (ironbase.disabledProviders).",
    );
    return;
  }
  const done = await auth.anthropic.signIn();
  if (done) {
    await refreshAuthState();
    void vscode.window.showInformationMessage("IronBase is connected to your Claude account.");
  }
}

async function signInGoogle(): Promise<void> {
  if (getConfig().disabledProviders.includes("gemini-oauth")) {
    void vscode.window.showWarningMessage(
      "Google sign-in is disabled in settings (ironbase.disabledProviders).",
    );
    return;
  }
  // Gemini is the one provider needing a one-time client, so guide rather than
  // just failing: the settings page and the README both get the user unstuck.
  if (!getGoogleClient()) {
    const choice = await vscode.window.showInformationMessage(
      "Gemini needs a free Google OAuth client first — about a minute to create. Claude and ChatGPT connect with no setup.",
      "How to set it up",
      "Open settings",
      "Use Claude or ChatGPT instead",
    );
    if (choice === "How to set it up") {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://github.com/mubinui/iron-base#connecting-gemini"),
      );
    } else if (choice === "Open settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "ironbase.google",
      );
    } else if (choice === "Use Claude or ChatGPT instead") {
      sidebar.reveal();
    }
    return;
  }

  const done = await auth.google.signIn();
  if (done) {
    await refreshAuthState();
    void vscode.window.showInformationMessage("IronBase is connected to your Google account.");
  }
}

async function signInOpenAi(): Promise<void> {
  if (getConfig().disabledProviders.includes("chatgpt-oauth")) {
    void vscode.window.showWarningMessage(
      "ChatGPT sign-in is disabled in settings (ironbase.disabledProviders).",
    );
    return;
  }
  const done = await auth.openai.signIn();
  if (done) {
    await refreshAuthState();
    void vscode.window.showInformationMessage("IronBase is connected to your ChatGPT account.");
  }
}

// --- Model selection -------------------------------------------------------

interface ModelPick extends vscode.QuickPickItem {
  provider: ProviderId | "auto";
  /** Empty leaves the model unpinned, so the provider decides. */
  model: string;
}

/**
 * Offers the models of every connected account. A model id belongs to exactly
 * one provider, so choosing one pins the provider as well — otherwise a Claude
 * id could be sent to ChatGPT the next time "auto" resolved differently.
 */
async function chooseModel(): Promise<void> {
  const connected = await auth.availableProviders();
  if (connected.length === 0) {
    sidebar.reveal();
    void vscode.window.showWarningMessage(
      "Connect an account first — IronBase offers the models that account allows.",
    );
    return;
  }

  const config = getConfig();
  const isCurrent = (provider: ProviderId | "auto", model: string): boolean =>
    config.provider === provider && config.model === model;

  const items: (ModelPick | vscode.QuickPickItem)[] = [
    {
      label: "Automatic",
      description: isCurrent("auto", "") ? "current" : undefined,
      detail: "First connected account, and whichever model that account allows.",
      provider: "auto",
      model: "",
    },
  ];

  for (const id of connected) {
    items.push({
      label: PROVIDER_LABELS[id],
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push({
      label: "Automatic",
      description: isCurrent(id, "") ? "current" : undefined,
      detail: `Always ${PROVIDER_LABELS[id]}, with whichever model the account allows.`,
      provider: id,
      model: "",
    });
    for (const choice of MODEL_CHOICES[id]) {
      items.push({
        label: choice.label,
        description: isCurrent(id, choice.id) ? `${choice.note} · current` : choice.note,
        detail: choice.id,
        provider: id,
        model: choice.id,
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "IronBase: Model",
    placeHolder: "Choose the account and model to review with",
    matchOnDetail: true,
  });
  if (!picked || !("provider" in picked)) return;

  const settings = vscode.workspace.getConfiguration("ironbase");
  await settings.update("provider", picked.provider, vscode.ConfigurationTarget.Global);
  await settings.update("model", picked.model, vscode.ConfigurationTarget.Global);
  await refreshAuthState();

  void vscode.window.showInformationMessage(
    picked.model
      ? `IronBase will review with ${picked.label}.`
      : picked.provider === "auto"
        ? "IronBase will choose an account and model automatically."
        : `IronBase will use ${PROVIDER_LABELS[picked.provider]}, with an automatic model.`,
  );
}

/** Drops the cached index so the next review re-reads everything from scratch. */
async function clearIndex(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage("Open a folder first.");
    return;
  }
  await indexStore.clear(folder.uri);
  void vscode.window.showInformationMessage(
    "Project index cleared. The next review will rebuild it from scratch.",
  );
}

async function signOut(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "Sign out of every provider and delete all stored IronBase credentials?",
    { modal: true },
    "Sign out",
  );
  if (confirm !== "Sign out") return;
  await auth.signOutAll();
  diagnostics.clear();
  await refreshAuthState();
  void vscode.window.showInformationMessage("IronBase credentials cleared.");
}

// --- Report commands -------------------------------------------------------

async function doExport(): Promise<void> {
  const report = lastReport ?? ReportPanel.active?.currentReport;
  if (!report) {
    void vscode.window.showInformationMessage(
      "Run a review first — there's no report to export yet.",
    );
    return;
  }
  await exportReport(report);
}

function showReport(): void {
  if (!lastReport || !lastRoot) {
    void vscode.window.showInformationMessage("No review has been run in this session yet.");
    return;
  }
  ReportPanel.show(extensionUri, lastReport, lastRoot);
}

// --- Developer commands ----------------------------------------------------

async function dumpRepoMap(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage("Open a folder first.");
    return;
  }
  const config = getConfig();
  const source = new vscode.CancellationTokenSource();
  try {
    const scan = await scanWorkspace(
      folder,
      { maxFiles: config.maxFiles, ignoreGlobs: config.ignoreGlobs },
      source.token,
    );
    const index = await indexStore.load(folder.uri, folder.name);
    const stats = await updateIndex(index, scan, source.token);
    await indexStore.save(index);
    const digest = buildDigest(index, scan);
    log.show();
    log.info(
      `Index: ${stats.reindexed} parsed, ${stats.reused} cached, ${stats.elapsedMs}ms. ` +
        `Brief is ~${Math.ceil(digest.length / 4)} tokens.`,
    );
    log.raw(`\n${digest}\n\n`);
  } finally {
    source.dispose();
  }
}

async function pingModel(): Promise<void> {
  const client = await auth.getActiveClient();
  if (!client) {
    void vscode.window.showWarningMessage("Sign in first.");
    return;
  }
  const source = new vscode.CancellationTokenSource();
  log.show();
  log.info(`Pinging ${PROVIDER_LABELS[client.id]} (${client.model})…`);
  try {
    const turn = await client.chat(
      {
        system: "You are a helpful assistant. Answer in one short sentence.",
        messages: [{ role: "user", text: "Say hello and name the model you are." }],
        tools: [],
        maxTokens: 256,
        model: client.model,
      },
      (event) => {
        if (event.type === "text") log.raw(event.delta);
      },
      source.token,
    );
    log.raw("\n");
    log.info(
      `Ping finished: stop=${turn.stopReason}, in=${turn.usage.inputTokens}, out=${turn.usage.outputTokens}`,
    );
  } finally {
    source.dispose();
  }
}

// --- Shared helpers --------------------------------------------------------

async function reportError(err: unknown): Promise<void> {
  log.error("Command failed", err);

  if (err instanceof LlmHttpError) {
    if (err.status === 401 || err.status === 403) {
      // Which account failed depends on who is active, so offer all three.
      const active = await auth.getActiveClient();
      const label = active ? PROVIDER_LABELS[active.id] : "Your account";
      const choice = await vscode.window.showErrorMessage(
        `${label} rejected the request — the session may have expired.`,
        "Sign in again",
        "Use a different account",
      );
      if (choice === "Sign in again") {
        if (active?.id === "chatgpt-oauth") await signInOpenAi();
        else if (active?.id === "gemini-oauth") await signInGoogle();
        else await signInAnthropic();
      } else if (choice === "Use a different account") {
        sidebar.reveal();
      }
      return;
    }
    if (err.status === 429) {
      void vscode.window.showWarningMessage(
        `Rate limited by the provider${
          err.retryAfterSeconds ? ` — try again in about ${err.retryAfterSeconds}s.` : "."
        } Subscription and free tiers cap usage; connecting a second account gives you somewhere to fall back to.`,
      );
      return;
    }
    const choice = await vscode.window.showErrorMessage(
      `The AI provider returned an error (HTTP ${err.status}).`,
      "Show details",
    );
    if (choice === "Show details") log.show();
    return;
  }

  const message = err instanceof Error ? err.message : describeError(err);
  const choice = await vscode.window.showErrorMessage(
    `IronBase: ${message}`,
    "Show details",
  );
  if (choice === "Show details") log.show();
}
