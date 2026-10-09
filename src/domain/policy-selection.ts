import { limits } from "../platform/config";
import type { PolicyDocument } from "./contracts";

const synonyms: Readonly<Record<string, readonly string[]>> = {
  billing: [
    "charge",
    "charged",
    "payment",
    "invoice",
    "refund",
    "billing",
    "cobro",
    "cargo",
    "pago",
    "factura",
  ],
  duplicate: ["double", "twice", "duplicate", "again", "duplicado", "duplicada", "doble"],
  premium: ["premium", "plan", "upgrade", "suscripcion"],
  activation: ["activate", "activation", "enable", "access", "activar", "activacion", "acceso"],
  password: [
    "password",
    "reset",
    "login",
    "sign",
    "credential",
    "contrasena",
    "clave",
    "restablecer",
    "inicio",
  ],
  export: ["export", "csv", "download", "file", "exportar", "descarga", "descargar", "archivo"],
  incident: [
    "incident",
    "outage",
    "unavailable",
    "error",
    "urgent",
    "incidente",
    "caida",
    "interrupcion",
  ],
  escalation: ["escalate", "escalation", "urgent", "derivar", "escalado", "urgente"],
};

const stopWords = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "been",
  "but",
  "can",
  "could",
  "from",
  "have",
  "help",
  "into",
  "just",
  "me",
  "more",
  "need",
  "please",
  "that",
  "the",
  "this",
  "with",
  "would",
  "fictional",
  "customer",
  "question",
  "asks",
  "demo",
  "support",
  "como",
  "con",
  "cuando",
  "de",
  "del",
  "el",
  "en",
  "es",
  "esta",
  "este",
  "la",
  "las",
  "lo",
  "los",
  "mi",
  "necesito",
  "por",
  "que",
  "quiero",
  "se",
  "un",
  "una",
  "y",
]);

export function selectPolicies(
  subject: string,
  body: string,
  documents: readonly PolicyDocument[],
): PolicyDocument[] {
  const queryTokens = expand(tokens(`${subject} ${body}`));
  if (queryTokens.size === 0) return [];

  return documents
    .map((document) => {
      const titleTokens = expand(tokens(document.title));
      const contentTokens = expand(tokens(document.content));
      let titleMatches = 0;
      let contentMatches = 0;
      for (const token of queryTokens) {
        if (titleTokens.has(token)) titleMatches += 1;
        if (contentTokens.has(token)) contentMatches += 1;
      }
      return { document, score: titleMatches * 2 + contentMatches, titleMatches, contentMatches };
    })
    .filter((item) => item.score >= 2 && item.contentMatches >= 1 && item.titleMatches >= 1)
    .sort(
      (left, right) =>
        right.score - left.score || left.document.key.localeCompare(right.document.key),
    )
    .slice(0, limits.maxSelectedPolicies)
    .map((item) => item.document);
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase("en")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[a-z0-9]{3,}/g)
      ?.filter((word) => !stopWords.has(word)) ?? [],
  );
}

function expand(input: ReadonlySet<string>): Set<string> {
  const output = new Set(input);
  for (const [key, values] of Object.entries(synonyms)) {
    if (input.has(key) || values.some((value) => input.has(value))) {
      output.add(key);
      for (const value of values) output.add(value);
    }
  }
  return output;
}
