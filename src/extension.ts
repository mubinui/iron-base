import * as vscode from "vscode";
import { AuthManager, type ApiKeyProvider } from "./auth/authManager";
import { ChatController } from "./chat/chatController";
import { ChatPanel } from "./chat/chatPanel";
import { getConfig, getGoogleClient } from "./config";
import { runAnalysis, type ProgressEvent } from "./engine/agentLoop";
import type { AnalysisReport } from "./engine/findings";
import type { RunMode } from "./engine/prompts";
import {
  ALL_PROVIDERS,
  LlmCancelledError,
  LlmHttpError,
  MODEL_CHOICES,
  PROVIDER_CREDENTIALS,
  PROVIDER_DETAILS,
  PROVIDER_LABELS,
  PROVIDER_SIGNUP,
  type LlmClient,
  type ProviderId,
} from "./llm/types";
import { buildDigest } from "./memory/digest";
import { updateIndex } from "./memory/indexer";
import { IndexStore, rememberFindings } from "./memory/store";
import { SessionStore } from "./chat/sessionStore";
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
let sessionStore: SessionStore;
let lastReport: AnalysisReport | undefined;
let lastRoot: vscode.Uri | undefined;
let activeRun: vscode.CancellationTokenSource | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  log.info("IronBase activated.");

  extensionUri = context.extensionUri;
  indexStore = new IndexStore(context.globalStorageUri);
  sessionStore = new SessionStore(context.globalStorageUri);
  auth = new AuthManager(context);
  sidebar = new SidebarView(context.extensionUri);
  diagnostics = new DiagnosticsPublisher(context);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "ironbase.sidebar.focus";
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarView.viewType, sidebar),
    ChatController.registerOriginalProvider(),
    auth.onDidChange(() => void refreshAuthState()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ironbase")) void refreshAuthState();
    }),
    register("ironbase.analyze", () => startRun({ kind: "review" })),
    register("ironbase.scalabilityCheck", startScalabilityCheck),
    register("ironbase.build", openBuildPanel),
    register("ironbase.newBuild", () => withBuildPanel((panel) => panel.newSession())),
    register("ironbase.switchBuild", () => withBuildPanel((panel) => panel.switchSession())),
    register("ironbase.exportBuild", () => withBuildPanel((panel) => panel.exportSession())),
    register("ironbase.revertRun", revertRun),
    register("ironbase.buildInEditor", openBuildInEditor),
    register("ironbase.buildHome", () => sidebar.showHome()),
    register("ironbase.connectAccount", connectAccount),
    register("ironbase.useConnectedAccount", useConnectedAccount),
    register("ironbase.signInAnthropic", signInAnthropic),
    register("ironbase.signInGoogle", signInGoogle),
    register("ironbase.signInOpenAi", signInOpenAi),
    register("ironbase.chooseModel", chooseModel),
    register("ironbase.clearIndex", clearIndex),
    register("ironbase.signOutProvider", signOutProvider),
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
  ChatController.active?.stopRun();
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
  const connected = await auth.availableProviders();

  // Settings can point at an account whose credential is not there — a key that
  // was signed out, or a provider picked from the model list and never
  // connected. `getActiveClient` honours the pin and returns nothing, which is
  // correct but indistinguishable from "signed out" unless we say so here.
  const pinned = getConfig().provider;
  const pinnedMissing =
    !client && pinned !== "auto" && connected.length > 0 ? pinned : undefined;

  sidebar.setState({
    providerLabel: label,
    providerId: client?.id,
    connected,
    pinnedMissing,
    model: client ? describeModel(client) : undefined,
  });

  statusBar.text = pinnedMissing
    ? `$(warning) IronBase: ${PROVIDER_LABELS[pinnedMissing]} not connected`
    : `$(pulse) IronBase: ${label ?? "sign in"}`;
  statusBar.tooltip = pinnedMissing
    ? `Settings point at ${PROVIDER_LABELS[pinnedMissing]}, which has no stored credential. Click to fix.`
    : client
      ? `IronBase is using ${label} (${client.model})`
      : "IronBase — click to connect an AI account";
  statusBar.show();
}

/**
 * Unsticks a pin left on an account that is not connected.
 *
 * Clearing it back to `auto` is the right repair rather than guessing a
 * provider: `auto` picks the first connected account in a defined order, which
 * is what someone with exactly one account signed in means anyway.
 */
async function useConnectedAccount(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("ironbase");
  await settings.update("provider", "auto", vscode.ConfigurationTarget.Global);
  await settings.update("model", "", vscode.ConfigurationTarget.Global);
  await refreshAuthState();

  const client = await auth.getActiveClient();
  void vscode.window.showInformationMessage(
    client
      ? `IronBase is now using ${PROVIDER_LABELS[client.id]}.`
      : "No account is connected yet — connect one to get started.",
  );
}

/** Names the resolved model the way the picker lists it, so the two agree. */
function describeModel(client: LlmClient): { label: string; automatic: boolean } {
  const known = MODEL_CHOICES[client.id].find((choice) => choice.id === client.model);
  return {
    label: known?.label ?? client.model,
    automatic: getConfig().model.length === 0,
  };
}

// --- Build panel -----------------------------------------------------------

/**
 * Opens the build panel, connecting an account first if there is none.
 *
 * The panel is usable without one — it just cannot run — but sending someone to
 * an empty composer that rejects their first message is a worse introduction
 * than asking up front.
 */
async function openBuildPanel(): Promise<void> {
  if (!(await auth.getActiveClient())) {
    const choice = await vscode.window.showWarningMessage(
      "IronBase needs an AI account to build with.",
      "Connect an account",
    );
    if (choice !== "Connect an account") return;
    await connectAccount();
    if (!(await auth.getActiveClient())) return;
  }
  // The sidebar, not an editor tab. You are already there when you ask for a
  // build, and being thrown into a new tab to answer the first permission
  // prompt is a context switch nobody asked for. `Open in editor` is in the
  // build header for when a diff wants the room.
  const controller = ChatController.forWorkspace({ extensionUri, auth, indexStore, sessionStore });
  if (controller) sidebar.showBuild(controller);
}

/**
 * Runs an action against the build panel, opening it first if it is closed.
 *
 * Every one of these is reachable from the command palette, where "no panel is
 * open" is a state the person is trying to leave rather than one worth being
 * told about.
 */
async function withBuildPanel(
  action: (controller: ChatController) => Promise<void> | void,
): Promise<void> {
  const controller = ChatController.forWorkspace({ extensionUri, auth, indexStore, sessionStore });
  if (!controller) return;
  if (sidebar.currentScreen !== "build" && !ChatPanel.active) sidebar.showBuild(controller);
  await action(controller);
}

/** Puts every file the current build session wrote back to how it started. */
async function revertRun(): Promise<void> {
  const controller = ChatController.active;
  if (!controller) {
    void vscode.window.showInformationMessage(
      "There is no build to revert — nothing has been built in this window yet.",
    );
    return;
  }
  await controller.revertAll();
}

/** Moves the conversation into an editor tab, where a diff has room. */
function openBuildInEditor(): void {
  ChatPanel.show({ extensionUri, auth, indexStore, sessionStore });
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
    // "Nothing is connected" and "the provider you pinned has no credential"
    // are different problems with different fixes, and saying the first when
    // the second is true sends people to edit settings that were already
    // correct — the key never lived there.
    const pinned = getConfig().provider;
    const message =
      pinned !== "auto" && !(await auth.hasCredential(pinned))
        ? `Settings point at ${PROVIDER_LABELS[pinned]}, but no ${PROVIDER_LABELS[pinned]} credential is stored. ` +
          "API keys are kept in your system keychain, not in settings.json — connect the account to add one."
        : "Connect an AI account and IronBase will use it to review your code.";

    const choice = await vscode.window.showWarningMessage(message, "Connect an account");
    if (choice === "Connect an account") await connectAccount();
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
    fixCount: 0,
    activity: "Scanning workspace…",
    startedAt: runStartedAt,
    usage: undefined,
  });
  statusBar.text = "$(sync~spin) IronBase: reviewing…";

  let findingCount = 0;
  let fixCount = 0;
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
      case "fix":
        fixCount++;
        sidebar.setState({ fixCount });
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
      // Resolved per step, so switching account or model mid-review is picked up
      // by the next request instead of needing a fresh run.
      getClient: () => auth.getActiveClient(),
      getFallback: (exclude) => auth.nextConnectedAfter(exclude),
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
        fixCount: report.fixes.length,
        elapsedMs: Date.now() - runStartedAt,
        totalTokens: lastUsage
          ? lastUsage.inputTokens + lastUsage.outputTokens
          : undefined,
      },
    });
    log.info(
      `Review finished: grade ${report.grade}, ${report.findings.length} findings, ` +
        `${report.fixes.length} applicable fixes.`,
    );
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

/** Stops whichever run is going — the review, or a build in the panel. */
function cancelRun(): void {
  if (activeRun) {
    activeRun.cancel();
    void vscode.window.showInformationMessage("Cancelling the review…");
    return;
  }
  if (ChatController.active) {
    ChatController.active.stopRun();
    return;
  }
  void vscode.window.showInformationMessage("Nothing is running.");
}

// --- Auth commands ---------------------------------------------------------

/**
 * The single front door: pick a provider, then run whatever that provider needs.
 *
 * There is one of these rather than a command per provider because the three
 * ways of connecting — an OAuth round trip, pasting a key, starting a local
 * server — are an implementation detail the user should not have to know before
 * choosing. Every backend the engine can actually run on appears here, so the
 * list cannot drift out of step with `ProviderId` the way the hard-coded
 * three-account menu did.
 */
async function connectAccount(): Promise<void> {
  const config = getConfig();
  const connected = new Set(await auth.availableProviders());

  interface ProviderPick extends vscode.QuickPickItem {
    id: ProviderId;
  }
  const items: ProviderPick[] = [];
  for (const id of ALL_PROVIDERS) {
    if (config.disabledProviders.includes(id)) continue;
    const isConnected = connected.has(id);
    items.push({
      id,
      label: PROVIDER_LABELS[id],
      description: isConnected ? "connected" : undefined,
      detail: PROVIDER_DETAILS[id],
    });
  }
  if (items.length === 0) {
    void vscode.window.showWarningMessage(
      "Every provider is turned off in settings (ironbase.disabledProviders).",
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "IronBase: Connect an account",
    placeHolder: "Choose the account to review with",
    matchOnDetail: true,
  });
  if (!picked) return;

  switch (PROVIDER_CREDENTIALS[picked.id]) {
    case "oauth":
      if (picked.id === "anthropic-oauth") await signInAnthropic();
      else if (picked.id === "chatgpt-oauth") await signInOpenAi();
      else await signInGoogle();
      return;
    case "apiKey":
      if (picked.id === "chatgpt-web") await connectChatGptWeb();
      else await signInWithApiKey(picked.id as ApiKeyProvider);
      return;
    case "local":
      await connectOllama();
      return;
  }
}

/** Takes a key, checks it is plausible, and stores it in the keychain. */
async function signInWithApiKey(id: ApiKeyProvider): Promise<void> {
  const label = PROVIDER_LABELS[id];
  const signup = PROVIDER_SIGNUP[id];

  const key = await vscode.window.showInputBox({
    title: `Connect ${label}`,
    prompt: signup ? `Paste your ${label} API key. Get one at ${signup}` : `Paste your ${label} API key.`,
    placeHolder: "sk-…",
    ignoreFocusOut: true,
    password: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "Paste a key, or press Escape to cancel.";
      // Only the shape is checked here; whether the key actually works is a
      // question only the provider can answer, and it will on the first review.
      if (/\s/.test(trimmed)) return "An API key does not contain spaces.";
      if (trimmed.length < 16) return "That looks too short to be an API key.";
      return undefined;
    },
  });
  if (key === undefined) {
    // Escaping the box is the moment to offer the console link, since the most
    // likely reason for backing out is not having a key yet.
    if (signup) {
      const choice = await vscode.window.showInformationMessage(
        `${label} needs an API key. Its free tier covers a review or two.`,
        "Get a key",
      );
      if (choice === "Get a key") await vscode.env.openExternal(vscode.Uri.parse(signup));
    }
    return;
  }

  await auth.setApiKey(id, key);
  await pinProvider(id);
  await refreshAuthState();
  void vscode.window.showInformationMessage(`IronBase is connected to ${label}.`);
}

/**
 * Connects a plain ChatGPT account by pasting the browser session token.
 *
 * Gated behind an explicit acknowledgement rather than a quiet paste box. The
 * cost of this provider does not land on IronBase — it lands on the account,
 * and the person pasting the token is the one who carries it, so they get to
 * read what they are agreeing to first.
 */
async function connectChatGptWeb(): Promise<void> {
  const proceed = await vscode.window.showWarningMessage(
    "ChatGPT (web) drives your account through the undocumented endpoint the chatgpt.com page uses.",
    {
      modal: true,
      detail:
        "This works with a free account, and it is experimental:\n\n" +
        "• Automated use of ChatGPT is against OpenAI's terms — your account could be suspended.\n" +
        "• The endpoint is undocumented and breaks without warning.\n" +
        "• It has no real tool calling, so reviews are less reliable than any other provider.\n" +
        "• If OpenAI's anti-automation check is active, IronBase will not work around it.\n\n" +
        "Ollama, Groq, Gemini, Kimi and Mistral all have free options that work properly.",
    },
    "I understand — connect anyway",
  );
  if (proceed !== "I understand — connect anyway") return;

  const token = await vscode.window.showInputBox({
    title: "ChatGPT (web) session token",
    prompt:
      "Sign in at chatgpt.com, open https://chatgpt.com/api/auth/session, and paste the accessToken value.",
    placeHolder: "eyJhbGciOi…",
    ignoreFocusOut: true,
    password: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "Paste the accessToken, or press Escape to cancel.";
      // Session tokens are JWTs. Catching the wrong paste here beats a 401 on
      // the first review, since the token is invisible once stored.
      if (!/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(trimmed)) {
        return "That does not look like an accessToken — it should be a long value starting with \"ey\".";
      }
      return undefined;
    },
  });
  if (!token) return;

  await auth.setApiKey("chatgpt-web", token);
  await pinProvider("chatgpt-web");
  await refreshAuthState();
  void vscode.window.showInformationMessage(
    "Connected to ChatGPT (web). The token expires after a few hours — reconnect when reviews start failing with a rejected session.",
  );
}

/** Confirms a local server is actually up before calling it connected. */
async function connectOllama(): Promise<void> {
  const base = getConfig().ollamaBaseUrl;
  if (await auth.hasCredential("ollama")) {
    await pinProvider("ollama");
    await refreshAuthState();
    const models = await auth.listModels("ollama");
    void vscode.window.showInformationMessage(
      models.length > 0
        ? `IronBase is using Ollama at ${base} (${models.length} model(s) available).`
        : `IronBase is using Ollama at ${base}. Pull a model to review with, e.g. \`ollama pull qwen3-coder:30b\`.`,
    );
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `Nothing is answering at ${base}. Start Ollama, then connect again.`,
    "Install Ollama",
    "Change the address",
  );
  if (choice === "Install Ollama") {
    await vscode.env.openExternal(vscode.Uri.parse(PROVIDER_SIGNUP.ollama ?? "https://ollama.com"));
  } else if (choice === "Change the address") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "ironbase.ollama");
  }
}

/**
 * Points the next run at the account just connected.
 *
 * Without this, connecting an account appears to do nothing. `auto` resolves in
 * a fixed order, so a newly added provider lower down that order is ignored
 * until the one above it is signed out — and worse, a pin left on an account
 * whose credential is gone makes a *successful* sign-in look like a failed one,
 * because the sidebar has no client to show and falls back to the sign-in page.
 *
 * Every way of connecting has to do this. The three OAuth flows did not, which
 * is exactly how that second case turned up in the wild.
 */
async function pinProvider(id: ProviderId): Promise<void> {
  const settings = vscode.workspace.getConfiguration("ironbase");
  await settings.update("provider", id, vscode.ConfigurationTarget.Global);
  // The model setting belongs to whichever provider it was chosen for, so it
  // cannot carry over — a Claude id sent to DeepSeek is a guaranteed 400.
  await settings.update("model", "", vscode.ConfigurationTarget.Global);
}

async function signInAnthropic(): Promise<void> {
  if (getConfig().disabledProviders.includes("anthropic-oauth")) {
    void vscode.window.showWarningMessage(
      "Claude account sign-in is disabled in settings (ironbase.disabledProviders).",
    );
    return;
  }
  const done = await auth.anthropic.signIn();
  if (done) {
    await pinProvider("anthropic-oauth");
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
    await pinProvider("gemini-oauth");
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
    await pinProvider("chatgpt-oauth");
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

/** Sentinel for the "type your own id" row; never written to settings. */
const CUSTOM_MODEL = "\0custom";

/**
 * How many live-fetched models to append per provider. OpenRouter alone lists
 * hundreds; a picker that long is not a picker, and the type-your-own row
 * covers whatever falls off the end.
 */
const MAX_LISTED_MODELS = 40;

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

    // Ask the provider what it actually offers. A curated list goes stale the
    // moment a vendor ships a model, and for OpenRouter or a local Ollama the
    // catalogue is specific to the account or machine — nothing shipped in this
    // build could know it.
    const listed = await auth.listModels(id);
    const known = new Set(MODEL_CHOICES[id].map((c) => c.id));
    const extra = listed.filter((model) => !known.has(model)).slice(0, MAX_LISTED_MODELS);
    for (const model of extra) {
      items.push({
        label: model,
        description: isCurrent(id, model) ? "available · current" : "available",
        detail: model,
        provider: id,
        model,
      });
    }
    // Providers rename model ids without notice, and an account is sometimes
    // entitled to one this build has never heard of. Typing it must stay possible.
    items.push({
      label: "$(edit) Enter a model id…",
      description: "Type any id your account allows",
      provider: id,
      model: CUSTOM_MODEL,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "IronBase: Model",
    placeHolder: "Choose the account and model to review with",
    matchOnDetail: true,
  });
  if (!picked || !("provider" in picked)) return;

  let model = picked.model;
  if (model === CUSTOM_MODEL) {
    const typed = await vscode.window.showInputBox({
      title: `Model id for ${PROVIDER_LABELS[picked.provider as ProviderId]}`,
      prompt: "IronBase will send this id exactly as typed.",
      placeHolder: "e.g. gpt-5.2-codex",
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 ? "Enter a model id, or press Escape to cancel." : undefined,
    });
    if (!typed) return;
    model = typed.trim();
  }

  const settings = vscode.workspace.getConfiguration("ironbase");
  await settings.update("provider", picked.provider, vscode.ConfigurationTarget.Global);
  await settings.update("model", model, vscode.ConfigurationTarget.Global);
  await refreshAuthState();

  void vscode.window.showInformationMessage(
    model
      ? `IronBase will review with ${model}.`
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

/**
 * Disconnects one account, leaving the others alone.
 *
 * The all-or-nothing sign-out is still there for clearing the machine, but it
 * is the wrong tool for "this key is wrong" or "stop using my work account" —
 * which previously meant signing out of everything and reconnecting each one.
 */
async function signOutProvider(): Promise<void> {
  const connected = await auth.availableProviders();
  if (connected.length === 0) {
    void vscode.window.showInformationMessage("No accounts are connected.");
    return;
  }

  interface Pick extends vscode.QuickPickItem {
    id: ProviderId;
  }
  const picked = await vscode.window.showQuickPick<Pick>(
    connected.map((id) => ({
      id,
      label: PROVIDER_LABELS[id],
      detail: PROVIDER_DETAILS[id],
    })),
    { title: "IronBase: Disconnect an account", placeHolder: "Choose the account to sign out of" },
  );
  if (!picked) return;

  await auth.signOut(picked.id);

  // Leaving the setting pinned to a provider with no credential would make the
  // next review fail with "nothing connected" instead of using what is left.
  if (getConfig().provider === picked.id) {
    const settings = vscode.workspace.getConfiguration("ironbase");
    await settings.update("provider", "auto", vscode.ConfigurationTarget.Global);
    await settings.update("model", "", vscode.ConfigurationTarget.Global);
  }
  await refreshAuthState();
  void vscode.window.showInformationMessage(
    `Disconnected ${PROVIDER_LABELS[picked.id]}.`,
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
      const active = await auth.getActiveClient();
      const label = active ? PROVIDER_LABELS[active.id] : "Your account";
      // What "sign in again" means depends on how this provider authenticates:
      // an expired OAuth session needs a new round trip, a rejected API key
      // needs a new key. Sending a DeepSeek user into an Anthropic OAuth flow —
      // which is what the old fallback did — could not have helped anyone.
      const isKey = active !== undefined && PROVIDER_CREDENTIALS[active.id] === "apiKey";
      const choice = await vscode.window.showErrorMessage(
        isKey
          ? `${label} rejected the API key.`
          : `${label} rejected the request — the session may have expired.`,
        isKey ? "Enter a new key" : "Sign in again",
        "Use a different account",
      );
      if (choice === "Sign in again" || choice === "Enter a new key") {
        if (active === undefined) await connectAccount();
        else if (active.id === "chatgpt-web") await connectChatGptWeb();
        else if (isKey) await signInWithApiKey(active.id as ApiKeyProvider);
        else if (active.id === "chatgpt-oauth") await signInOpenAi();
        else if (active.id === "gemini-oauth") await signInGoogle();
        else if (active.id === "anthropic-oauth") await signInAnthropic();
        else await connectAccount();
      } else if (choice === "Use a different account") {
        await connectAccount();
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
