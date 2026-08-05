/**
 * Which Claude models accept an effort hint.
 *
 * `output_config.effort` arrived with Opus 4.5 and is not universal: Haiku 4.5
 * and Sonnet 4.5 and older reject it outright with "This model does not support
 * the effort parameter" — a 400, which fails the whole review before its first
 * tool call. Sending it unconditionally is what made picking Haiku in the model
 * menu look like the extension was broken.
 *
 * An allowlist is the safe default: a model id this build has never seen simply
 * goes without the hint rather than risking the 400. The client also watches for
 * that specific error at runtime and drops the parameter permanently, which
 * covers whatever this pattern gets wrong.
 *
 * Kept free of `vscode` imports so it can be tested without an editor host.
 */
const EFFORT_MODELS = /(opus-(4-5|4-6|4-7|4-8|5)|sonnet-(4-6|5)|fable-5|mythos-5)/;

export function supportsEffort(model: string): boolean {
  return EFFORT_MODELS.test(model.toLowerCase());
}

/** True for the specific 400 that means "this model has no effort parameter". */
export function isEffortRejection(status: number, body: string): boolean {
  return status === 400 && /effort/i.test(body);
}
