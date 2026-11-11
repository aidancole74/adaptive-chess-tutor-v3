/**
 * Optional AI explanations (feature flag, user-supplied key stored only on this device).
 * The model receives only the exercise's verified facts; its answer is checked by verifyClaims and
 * rejected if it mentions any move or square that the facts do not contain.
 * The SDK is imported lazily so it is not part of the main bundle.
 */
import type { Exercise } from './types';
import { factsPayload, verifyClaims } from './verifyClaims';

export const LLM_MODEL = 'claude-opus-5-5';

export type LlmResult =
  | { status: 'ok'; text: string }
  | { status: 'rejected'; text: string; unsupported: string[] }
  | { status: 'refused' }
  | { status: 'error'; message: string };

const SYSTEM = [
  'You explain chess training exercises to a learner.',
  'You are given a JSON object of verified facts: engine lines, tablebase results, puzzle solutions, detected motifs, heuristic features and book statistics.',
  'Use only those facts. Mention a move or square only if it appears in the facts. Do not evaluate positions yourself or add variations.',
  'If a fact is marked heuristic, say it is a heuristic description.',
  'Write two to four short sentences in plain language for a club player.',
].join(' ');

export async function explainWithLlm(ex: Exercise, apiKey: string): Promise<LlmResult> {
  if (!apiKey) return { status: 'error', message: 'No API key set.' };
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    // Browser use with the user's own key: the SDK refuses unless explicitly allowed.
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const response = await client.beta.messages.create({
      model: LLM_MODEL,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      // Server-side refusal fallback: routes a declined request to a suitable model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: factsPayload(ex) }],
    });
    if (response.stop_reason === 'refusal') return { status: 'refused' };
    const text = response.content
      .filter((b): b is Extract<(typeof response.content)[number], { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const check = verifyClaims(text, ex.facts);
    return check.ok ? { status: 'ok', text } : { status: 'rejected', text, unsupported: check.unsupported };
  } catch (e) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    if (e instanceof Anthropic.AuthenticationError) return { status: 'error', message: 'The API key was rejected.' };
    if (e instanceof Anthropic.RateLimitError) return { status: 'error', message: 'Rate limited; try again in a minute.' };
    if (e instanceof Anthropic.APIError) return { status: 'error', message: `API error ${e.status ?? ''}`.trim() };
    return { status: 'error', message: 'Could not reach the API (offline?).' };
  }
}
