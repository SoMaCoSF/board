import { experimental_decide as decide } from "ai";
import { CRITERIA, INSTRUCTIONS, type Kind } from "./kinds";

export async function classifyThread(messages: { from: string; text: string }[]): Promise<Kind> {
  const { answers } = await decide({
    model: "openai/gpt-6-luna-decisions",
    state: messages,
    questions: {
      kind: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA },
    },
  });
  return answers.kind.choice as Kind;
}
