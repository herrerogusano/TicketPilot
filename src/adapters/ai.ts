import type { PolicyDocument, TicketProposal } from "../domain/contracts";
import { proposalSchema } from "../domain/contracts";
import { buildPrompt, type PromptInput, proposalJsonSchema } from "../domain/prompt";
import { limits } from "../platform/config";

export const MODEL_NAME = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

export type ProposalValidation =
  | { kind: "valid"; proposal: TicketProposal }
  | { kind: "invalid_format" }
  | { kind: "unsupported_citation" };
export type ProposalInference =
  | ProposalValidation
  | { kind: "provider_error" }
  | { kind: "prompt_budget_exceeded" };
export type PreparedPrompt = ReturnType<typeof buildPrompt>;

export function validateProposalOutput(
  raw: unknown,
  selected: readonly PolicyDocument[],
): ProposalValidation {
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) return { kind: "invalid_format" };
  const selectedKeys = new Set(selected.map((policy) => policy.key));
  const citations = parsed.data.cited_policy_keys;
  if (citations.some((key) => !selectedKeys.has(key))) return { kind: "unsupported_citation" };
  if (
    (parsed.data.evidence_status === "SUPPORTED" &&
      (citations.length === 0 || parsed.data.draft_reply.trim().length === 0)) ||
    (parsed.data.evidence_status === "INSUFFICIENT_EVIDENCE" &&
      (citations.length > 0 || parsed.data.draft_reply.length > 0))
  ) {
    return { kind: "unsupported_citation" };
  }
  return { kind: "valid", proposal: parsed.data };
}

export class WorkersAiAdapter {
  constructor(private readonly binding: Ai) {}

  prepare(input: PromptInput): PreparedPrompt | null {
    const prompt = buildPrompt(input);
    const inputBytes = new TextEncoder().encode(
      `${prompt.system}${prompt.user}${JSON.stringify(proposalJsonSchema)}`,
    ).byteLength;
    if (prompt.includedPolicyKeys.length === 0 || inputBytes > 3_000) return null;
    return prompt;
  }

  async propose(
    prompt: PreparedPrompt,
    selected: readonly PolicyDocument[],
  ): Promise<ProposalInference> {
    const inputBytes = new TextEncoder().encode(
      `${prompt.system}${prompt.user}${JSON.stringify(proposalJsonSchema)}`,
    ).byteLength;
    if (inputBytes > 3_000 || Math.ceil(inputBytes / 3) > limits.maxModelInputTokens) {
      return { kind: "prompt_budget_exceeded" };
    }
    try {
      const result = await this.binding.run(MODEL_NAME, {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        temperature: 0,
        max_tokens: limits.maxModelOutputTokens,
        response_format: { type: "json_schema", json_schema: proposalJsonSchema },
      });
      const output: unknown = result;
      let response: unknown = output;
      if (typeof output === "object" && output !== null && "response" in output) {
        response = output.response;
      }
      let decoded: unknown = response;
      if (typeof response === "string") {
        try {
          decoded = JSON.parse(response) as unknown;
        } catch {
          return { kind: "invalid_format" };
        }
      }
      const included = new Set(prompt.includedPolicyKeys);
      return validateProposalOutput(
        decoded,
        selected.filter((policy) => included.has(policy.key)),
      );
    } catch {
      return { kind: "provider_error" };
    }
  }
}
