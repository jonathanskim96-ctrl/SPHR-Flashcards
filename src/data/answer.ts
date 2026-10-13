// Builds the answer record the app saves when she taps Check: graded, with the XP for the
// tier and the question's answer fingerprint. The record is then saved with guardedWrite.
import { answerFp } from '../domain/bank';
import { grade } from '../domain/grade';
import { xpFor } from '../domain/xp';
import type { Attempt, Bank, Mode, Question, Response } from '../domain/types';

export function buildAttempt(input: {
  bank: Bank;
  question: Question;
  response: Response;
  mode: Mode;
  now: Date;
  id?: string;
}): Attempt {
  const { bank, question, response } = input;
  const { correct } = grade(question, response);
  return {
    id: input.id ?? crypto.randomUUID(),
    questionId: question.id,
    revision: question.revision,
    answerFp: answerFp(question),
    correct,
    xp: xpFor(bank, question, correct),
    mode: input.mode,
    response,
    answeredAt: input.now.toISOString(),
  };
}
