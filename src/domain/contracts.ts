import { z } from "zod";

export const policyKeys = [
  "billing-double-charge",
  "premium-activation",
  "password-reset",
  "export-csv",
  "incident-escalation",
] as const;

export type PolicyKey = (typeof policyKeys)[number];

export const proposalSchema = z.object({
  category: z.enum(["BILLING", "ACCESS", "TECHNICAL", "OTHER"]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]),
  evidence_status: z.enum(["SUPPORTED", "INSUFFICIENT_EVIDENCE"]),
  summary: z.string().trim().min(1).max(240),
  draft_reply: z.string().max(1_500),
  cited_policy_keys: z.array(z.enum(policyKeys)).max(3),
  rationale: z.string().trim().min(1).max(300),
});

export type TicketProposal = z.infer<typeof proposalSchema>;

export type PolicyDocument = {
  key: PolicyKey;
  title: string;
  url: string;
  content: string;
  contentHash: string;
};

export type PolicyEvidence = Pick<PolicyDocument, "key" | "title" | "url" | "contentHash">;

export const policyEvidenceSchema = z
  .array(
    z.object({
      key: z.enum(policyKeys),
      title: z.string().min(1).max(240),
      url: z.url(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .max(3);

export type StoredProposal = TicketProposal & {
  proposalHash: string;
  revision: number;
  promptVersion: string;
  policyEvidence: PolicyEvidence[];
};

export type TicketLanguage = "en" | "es";

export function detectTicketLanguage(subject: string, body: string): TicketLanguage {
  const text = `${subject.slice(0, 160)} ${body.slice(0, 1_600)}`.toLocaleLowerCase("en");
  const spanishSignal =
    /[áéíóúñ¿¡]/i.test(text) ||
    /\b(?:ayuda|cobro|factura|necesito|quiero|contraseña|restablecer|derivar|puedo|tengo|por favor)\b/i.test(
      text,
    );
  if (spanishSignal) return "es";
  const englishSignal =
    /\b(?:i|i'm|my|the|please|help|need|want|charge|invoice|password|reset|can't|cannot|export|account|parking)\b/i.test(
      text,
    );
  return englishSignal ? "en" : "es";
}

export function unsupportedProposal(language: TicketLanguage = "es"): TicketProposal {
  return {
    category: "OTHER",
    priority: "LOW",
    evidence_status: "INSUFFICIENT_EVIDENCE",
    summary:
      language === "es"
        ? "No se encontró una política aplicable para responder con seguridad."
        : "No applicable policy was found, so a safe reply cannot be drafted.",
    draft_reply: "",
    cited_policy_keys: [],
    rationale:
      language === "es"
        ? "Revisión manual necesaria: la base de conocimiento no aporta evidencia suficiente."
        : "Manual review is required because the knowledge base does not provide sufficient evidence.",
  };
}
