import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatPolicyTitle, NotionClient, type NotionPolicySeed } from "../src/adapters/notion";
import type { PolicyKey } from "../src/domain/contracts";

export const policySeeds: readonly NotionPolicySeed[] = [
  {
    key: "billing-double-charge",
    title: "Duplicate billing",
    sections: [
      {
        heading: "Fictitious policy",
        text: "This policy and all examples are fictional demo content. A customer reporting two charges may be asked for the dates and amounts, but never for full card numbers or security codes.",
      },
      {
        heading: "Allowed actions",
        text: "Explain that support can review the duplicate charge and route the case to billing. Do not promise a refund or claim that a charge was reversed.",
      },
      {
        heading: "Constraints",
        text: "Never request payment credentials. Do not state that an account or payment system was changed.",
      },
      {
        heading: "Sample response",
        text: "Siento el posible cobro duplicado. Podemos revisar las fechas e importes y derivarlo al equipo de facturación; no compartas números completos de tarjeta ni códigos de seguridad.",
      },
    ],
  },
  {
    key: "premium-activation",
    title: "Premium activation",
    sections: [
      {
        heading: "Fictitious policy",
        text: "This policy and all examples are fictional demo content. Premium activation can take several minutes after a plan change.",
      },
      {
        heading: "Allowed actions",
        text: "Suggest signing out and back in once, then checking the plan page. If the plan still appears inactive, gather the approximate purchase time and escalate for account review.",
      },
      {
        heading: "Constraints",
        text: "Do not claim to activate, modify, or inspect an account. Never ask for a password or full payment credentials.",
      },
      {
        heading: "Sample response",
        text: "La activación puede tardar unos minutos. Prueba a cerrar sesión y volver a entrar; si el plan sigue sin aparecer, podemos derivarlo para una revisión segura.",
      },
    ],
  },
  {
    key: "password-reset",
    title: "Password reset and sign-in",
    sections: [
      {
        heading: "Fictitious policy",
        text: "This policy and all examples are fictional demo content. Password reset links are sent to the account email and expire after a short period.",
      },
      {
        heading: "Allowed actions",
        text: "Use the official password-reset page, request one new link, and check spam. If access remains blocked, escalate through account recovery.",
      },
      {
        heading: "Constraints",
        text: "Support must never request or repeat passwords, one-time codes, or reset links. Do not confirm whether an email address belongs to an account.",
      },
      {
        heading: "Sample response",
        text: "Usa la opción oficial de restablecimiento y solicita un enlace nuevo; revisa también la carpeta de correo no deseado. No compartas contraseñas ni códigos.",
      },
    ],
  },
  {
    key: "export-csv",
    title: "CSV export troubleshooting",
    sections: [
      {
        heading: "Fictitious policy",
        text: "This policy and all examples are fictional demo content. CSV exports may take longer for large date ranges or datasets.",
      },
      {
        heading: "Allowed actions",
        text: "Retry with a smaller date range, check that the browser allows downloads, and record the approximate time and any visible error for escalation.",
      },
      {
        heading: "Constraints",
        text: "Do not ask customers to send exported personal data in an unsecured reply. Do not claim that an export was generated or repaired.",
      },
      {
        heading: "Sample response",
        text: "Prueba con un intervalo de fechas menor y confirma que el navegador permite descargas. Si continúa el error, indícanos cuándo ocurrió y el mensaje visible, sin adjuntar datos personales.",
      },
    ],
  },
  {
    key: "incident-escalation",
    title: "Service incident escalation",
    sections: [
      {
        heading: "Fictitious policy",
        text: "This policy and all examples are fictional demo content. Widespread outages or repeated service errors require incident-team review.",
      },
      {
        heading: "Allowed actions",
        text: "Acknowledge the disruption, ask for the affected feature and approximate time, and escalate the report. Share only a confirmed public status-page notice.",
      },
      {
        heading: "Constraints",
        text: "Do not invent an incident, ETA, root cause, or resolution. Never claim that an escalation was completed unless a human confirms it.",
      },
      {
        heading: "Sample response",
        text: "Lamento la interrupción. Cuéntanos qué función falla y aproximadamente desde cuándo para que podamos derivar el informe; no puedo confirmar una causa ni un plazo sin información verificada.",
      },
    ],
  },
];

type ManifestEntry = { status: "creating" | "created" | "verified"; pageId?: string };
type SeedManifest = { version: 1; pages: Partial<Record<PolicyKey, ManifestEntry>> };
const manifestPath = resolve("seed-manifest-notion.json");

export function parseArgs(args: readonly string[]): { help: boolean; apply: boolean } {
  const unknown = args.filter((arg) => arg !== "--help" && arg !== "--apply");
  if (unknown.length > 0) throw new Error(`unknown_arguments:${unknown.join(",")}`);
  return { help: args.includes("--help"), apply: args.includes("--apply") };
}

export function assertDemoSeedEnvironment(value: string | undefined): void {
  if (value !== "demo") throw new Error("demo_configuration_required");
}

export async function seedNotion(
  client: NotionClient,
  parentPageId: string,
  apply: boolean,
  filePath = manifestPath,
): Promise<{ verified: number; wouldCreate: number }> {
  const manifest = await readManifest(filePath);
  const existingPages = await client.listChildPages(parentPageId);
  const report = { verified: 0, wouldCreate: 0 };

  for (const seed of policySeeds) {
    const matches = existingPages.filter((page) => page.key === seed.key);
    if (matches.length > 1) throw new Error(`duplicate_policy_key:${seed.key}`);
    let pageId = manifest.pages[seed.key]?.pageId ?? matches[0]?.id;
    const previous = manifest.pages[seed.key];

    if (pageId === undefined) {
      if (previous?.status === "creating") {
        throw new Error(`create_outcome_unknown_reconcile_before_retry:${seed.key}`);
      }
      report.wouldCreate += 1;
      if (!apply) continue;
      manifest.pages[seed.key] = { status: "creating" };
      await writeManifest(filePath, manifest);
      pageId = await client.createPolicyPage(parentPageId, seed);
      manifest.pages[seed.key] = { status: "created", pageId };
      await writeManifest(filePath, manifest);
    }

    const ref = matches.find((page) => page.id === pageId) ?? {
      id: pageId,
      key: seed.key,
      title: formatPolicyTitle(seed.key, seed.title),
      url: "",
    };
    const actual = await client.retrievePolicy(ref, parentPageId);
    const expected = seed.sections
      .map((section) => `${section.heading}\n${section.text}`)
      .join("\n");
    if (normalizeText(actual.content) !== normalizeText(expected)) {
      throw new Error(`existing_policy_content_differs_no_overwrite:${seed.key}`);
    }
    manifest.pages[seed.key] = { status: "verified", pageId };
    await writeManifest(filePath, manifest);
    report.verified += 1;
  }
  return report;
}

async function readManifest(path: string): Promise<SeedManifest> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === 1 &&
      "pages" in parsed &&
      typeof parsed.pages === "object" &&
      parsed.pages !== null
    ) {
      return parsed as SeedManifest;
    }
    throw new Error("invalid_notion_seed_manifest");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { version: 1, pages: {} };
    }
    throw error;
  }
}

async function writeManifest(path: string, manifest: SeedManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: npm run seed:notion [-- --apply]\nDefault is read-only; --apply creates missing child pages.\n",
    );
    return;
  }
  assertDemoSeedEnvironment(process.env.TICKETPILOT_ENV);
  const token = process.env.NOTION_TOKEN;
  const parentPageId = process.env.NOTION_PARENT_PAGE_ID;
  if (token === undefined || parentPageId === undefined) {
    throw new Error("NOTION_TOKEN_and_NOTION_PARENT_PAGE_ID_required");
  }
  const result = await seedNotion(new NotionClient(token), parentPageId, options.apply);
  process.stdout.write(
    `${JSON.stringify({ mode: options.apply ? "apply" : "read_only", ...result })}\n`,
  );
}

if (process.argv[1]?.includes("seed-notion")) {
  main().catch(() => {
    process.stderr.write(
      "Notion seed stopped safely. Inspect the local manifest and Notion child pages before retrying.\n",
    );
    process.exitCode = 1;
  });
}
