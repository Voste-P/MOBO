/** Predefined security questions for password recovery. IDs 1–7 are stable. */
export const SECURITY_QUESTIONS: { id: number; label: string }[] = [
  { id: 1, label: 'What was your childhood nickname?' },
  { id: 2, label: 'What is the name of your first school?' },
  { id: 3, label: 'What was the name of your first best friend?' },
  { id: 4, label: 'What is your favorite childhood food?' },
  { id: 5, label: 'What was your first mobile phone model?' },
  { id: 6, label: 'What is your favorite childhood game?' },
  { id: 7, label: 'What was the name of your first teacher?' },
];

/** Pre-computed map for O(1) lookup by question ID. */
const QUESTION_MAP = new Map(SECURITY_QUESTIONS.map(q => [q.id, q.label]));

export function getQuestionLabel(id: number): string {
  return QUESTION_MAP.get(id) ?? `Question #${id}`;
}
