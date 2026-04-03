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

export function getQuestionLabel(id: number): string {
  return SECURITY_QUESTIONS.find((q) => q.id === id)?.label ?? `Question #${id}`;
}
