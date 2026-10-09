import { z } from "zod";

const notionPageId = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;

export const runtimeConfigSchema = z.object({
  TICKETPILOT_ENV: z.literal("demo"),
  TICKETPILOT_VERSION: z.string().min(1).max(40),
  NOTION_PARENT_PAGE_ID: z.string().regex(notionPageId),
  SLACK_CHANNEL_ID: z.string().regex(/^C[A-Z0-9]+$/),
  SLACK_TEAM_ID: z.string().regex(/^T[A-Z0-9]+$/),
  SLACK_APPROVER_USER_ID: z.string().regex(/^[UW][A-Z0-9]+$/),
  DEMO_START_AT: z.iso.datetime({ offset: true }),
  HUBSPOT_SERVICE_KEY: z.string().min(1),
  NOTION_TOKEN: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  TEST_RECIPIENT_EMAIL: z.email(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type RuntimeConfigInput = Pick<
  Env,
  | "TICKETPILOT_ENV"
  | "TICKETPILOT_VERSION"
  | "NOTION_PARENT_PAGE_ID"
  | "SLACK_CHANNEL_ID"
  | "SLACK_TEAM_ID"
  | "SLACK_APPROVER_USER_ID"
  | "DEMO_START_AT"
  | "HUBSPOT_SERVICE_KEY"
  | "NOTION_TOKEN"
  | "SLACK_BOT_TOKEN"
  | "SLACK_SIGNING_SECRET"
  | "RESEND_API_KEY"
  | "TEST_RECIPIENT_EMAIL"
>;

export const limits = {
  maxTicketsPerUtcDay: 20,
  maxPollPages: 3,
  maxTicketTitleLength: 160,
  maxTicketBodyLength: 3_000,
  maxSelectedPolicies: 3,
  maxPolicyBlocks: 50,
  maxModelInputTokens: 3_000,
  maxModelOutputTokens: 450,
  maxProviderRetries: 3,
  slackRequestMaxAgeSeconds: 300,
  decisionTimeoutSeconds: 48 * 60 * 60,
} as const;

export function validateRuntimeConfig(input: RuntimeConfigInput): boolean {
  return runtimeConfigSchema.safeParse(input).success;
}
