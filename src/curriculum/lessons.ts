/**
 * Lesson cards. A lesson introduces a concept through a WORKED EXAMPLE taken from verified content
 * (the easiest available exercise for the concept) plus the curriculum facts (prerequisites, what comes next).
 * No free-text chess claims are written here.
 */
import type { Exercise } from '../exercises/types';
import type { AppPool } from '../content/pool';
import { explainExercise } from '../exercises/explain';
import { mulberry32 } from '../model/math';
import { CONCEPT_BY_ID, TIER_LABELS, conceptName } from './concepts';
import { STAGE_NEED } from './progress';

function previewPosition(ex: Exercise): { fen?: string; orientation?: 'white' | 'black'; preMoves?: string[] } {
  const it = ex.interaction;
  if (it.kind === 'line') return { fen: it.fen, orientation: it.orientation, preMoves: it.preMoves };
  if ('fen' in it && it.fen) return { fen: it.fen, orientation: it.orientation };
  return {};
}

export function buildLessonCard(conceptId: string, pool: AppPool): Exercise | null {
  const def = CONCEPT_BY_ID.get(conceptId);
  if (!def) return null;
  const examples = pool
    .sample(conceptId, 400, 6, mulberry32(conceptId.length * 7919))
    .map((c) => pool.materialize(c))
    .filter((e): e is Exercise => e !== null);
  const example = examples.filter((e) => e.verified && e.format !== 'lesson').sort((a, b) => a.difficulty - b.difficulty)[0];
  const prereqs = def.prereqs.map((p) => `${conceptName(p.id)}${p.type === 'recommends' ? ' (recommended)' : ''}`);
  const body: string[] = [
    `${def.name} — tier ${def.tier} (${TIER_LABELS[def.tier]}).`,
    prereqs.length ? `Builds on: ${prereqs.join(', ')}.` : 'This is a starting concept: no prerequisites.',
    `Next: ${STAGE_NEED.supported} supported exercises (hints available, slightly easier), ${STAGE_NEED.unsupported} unsupported ones, then a ${STAGE_NEED.check}-exercise mastery check without hints.`,
  ];
  let pos: ReturnType<typeof previewPosition> = {};
  if (example) {
    pos = previewPosition(example);
    body.push(`Worked example (${example.prompt.replace(/\.$/, '')}):`);
    for (const l of explainExercise(example, 'detailed', 1).lines) body.push(l);
  }
  const id = `lesson:${conceptId}`;
  return {
    id,
    itemId: id,
    domain: def.domain,
    conceptId,
    format: 'lesson',
    difficulty: 0,
    difficultySource: 'tier-prior',
    sim: { themes: ['lesson'], material: '' },
    phase: example?.phase ?? 'middlegame',
    color: example?.color ?? 'w',
    verified: true,
    prompt: `New concept: ${def.name}`,
    interaction: { kind: 'card', title: def.name, body, ...pos },
    facts: example?.facts ?? [],
  };
}
